// Issue, delegate, revoke, expire. Enforces invariants 1-7 and 10.
import type { Currency, Ledger } from "./ledger.js";
import { TreasuryError } from "./ledger.js";

export type EntitlementStatus = "active" | "expired" | "revoked";

// Field names match the spec table in CLAUDE.md exactly.
export interface Entitlement {
  id: string;
  agent_id: string;
  parent_id: string | null;
  tenant_id: string;
  amount_granted: bigint;
  amount_spent: bigint;
  amount_delegated: bigint;
  currency: Currency;
  /** Epoch millis. */
  expires_at: number;
  counterparty_allow: string[];
  status: EntitlementStatus;
  /** Root = 1. */
  depth: number;
}

export interface RequestEntitlementParams {
  tenantId?: string;
  agent_id: string;
  amount: bigint;
  ttl_seconds: number;
  parent_id?: string | null;
  counterparty_allow?: string[];
  now?: number;
}

export interface BalanceView {
  granted: bigint;
  spent: bigint;
  delegated: bigint;
  available: bigint;
  expires_at: number;
  status: EntitlementStatus;
}

const DEFAULT_TENANT = "default";
const MAX_DEPTH = 5;

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `ent_${idCounter}`;
}

function isSubset(child: string[], parent: string[]): boolean {
  if (parent.length === 0) return true; // empty = allow all, any child list is a subset
  return child.every((c) => parent.includes(c));
}

export class EntitlementStore {
  private byId = new Map<string, Entitlement>();
  private byParent = new Map<string, string[]>();
  private byAgent = new Map<string, string[]>();

  constructor(private ledger: Ledger) {}

  /** Looks up the raw record, lazily expiring it first if it's past due. */
  private touch(id: string, now: number): Entitlement {
    const ent = this.byId.get(id);
    if (!ent) throw new Error(`Unknown entitlement: ${id}`);
    if (ent.status === "active" && now >= ent.expires_at) {
      this.terminate(ent, now, "expired");
    }
    return ent;
  }

  get(id: string, now: number = Date.now()): Entitlement {
    return this.touch(id, now);
  }

  childrenOf(id: string): Entitlement[] {
    return (this.byParent.get(id) ?? []).map((cid) => this.byId.get(cid)!);
  }

  listByAgent(agentId: string, now: number = Date.now()): Entitlement[] {
    return (this.byAgent.get(agentId) ?? []).map((id) => this.touch(id, now));
  }

  request(params: RequestEntitlementParams): Entitlement {
    const now = params.now ?? Date.now();
    const tenantId = params.tenantId ?? DEFAULT_TENANT;
    const expiresAt = now + params.ttl_seconds * 1000;
    const counterpartyAllow = params.counterparty_allow ?? [];

    let parent: Entitlement | null = null;
    if (params.parent_id) {
      parent = this.touch(params.parent_id, now);
      if (parent.status === "expired") throw new TreasuryError("ENTITLEMENT_EXPIRED");
      if (parent.status === "revoked") throw new TreasuryError("ENTITLEMENT_REVOKED");

      if (parent.depth + 1 > MAX_DEPTH) throw new TreasuryError("DELEGATION_TOO_DEEP");

      const parentRemainder = parent.amount_granted - parent.amount_spent - parent.amount_delegated;
      if (params.amount > parentRemainder) throw new TreasuryError("PARENT_INSUFFICIENT");

      if (expiresAt > parent.expires_at) throw new TreasuryError("EXPIRY_EXCEEDS_PARENT");

      if (!isSubset(counterpartyAllow, parent.counterparty_allow)) {
        throw new TreasuryError("COUNTERPARTY_NOT_ALLOWED");
      }
    } else {
      // Root entitlement: draw directly from the pool.
      this.ledger.drawFromPool(tenantId, params.amount);
    }

    const ent: Entitlement = {
      id: nextId(),
      agent_id: params.agent_id,
      parent_id: parent ? parent.id : null,
      tenant_id: tenantId,
      amount_granted: params.amount,
      amount_spent: 0n,
      amount_delegated: 0n,
      currency: "USDC",
      expires_at: expiresAt,
      counterparty_allow: counterpartyAllow,
      status: "active",
      depth: parent ? parent.depth + 1 : 1,
    };

    this.byId.set(ent.id, ent);
    this.index(ent);

    if (parent) {
      parent.amount_delegated += ent.amount_granted;
    }

    return ent;
  }

  private index(ent: Entitlement): void {
    if (ent.parent_id) {
      const siblings = this.byParent.get(ent.parent_id) ?? [];
      siblings.push(ent.id);
      this.byParent.set(ent.parent_id, siblings);
    }
    const forAgent = this.byAgent.get(ent.agent_id) ?? [];
    forAgent.push(ent.id);
    this.byAgent.set(ent.agent_id, forAgent);
  }

  checkBalance(id: string, now: number = Date.now()): BalanceView {
    const ent = this.touch(id, now);
    const available = ent.amount_granted - ent.amount_spent - ent.amount_delegated;
    return {
      granted: ent.amount_granted,
      spent: ent.amount_spent,
      delegated: ent.amount_delegated,
      available,
      expires_at: ent.expires_at,
      status: ent.status,
    };
  }

  /** Applies a settlement's spend. Enforces invariants 1 and 4. */
  recordSpend(id: string, amount: bigint, now: number = Date.now()): Entitlement {
    const ent = this.touch(id, now);
    if (ent.status === "expired") throw new TreasuryError("ENTITLEMENT_EXPIRED");
    if (ent.status === "revoked") throw new TreasuryError("ENTITLEMENT_REVOKED");

    const remainder = ent.amount_granted - ent.amount_spent - ent.amount_delegated;
    if (amount > remainder) throw new TreasuryError("INSUFFICIENT_ENTITLEMENT");

    ent.amount_spent += amount;
    return ent;
  }

  /**
   * Terminates a single node (expired or revoked): recursively terminates
   * any still-active children first (depth-first), then releases its
   * reclaimable remainder up to its parent's `amount_delegated`, or — for a
   * root entitlement — to the pool. Atomic: all bookkeeping for the whole
   * subtree happens synchronously in this call.
   *
   * Only the truly-unspent remainder is reclaimed at each level: once a
   * child terminates, `amount_delegated` on this node is decremented by
   * that child's own reclaimable `unspent`, not its full `amount_granted`.
   * Whatever the child (or its descendants) actually settled stays parked
   * in this node's `amount_delegated` forever — it left the system via a
   * real settlement and can never be reclaimed by anyone up the chain.
   */
  private terminate(
    ent: Entitlement,
    now: number,
    reason: "expired" | "revoked"
  ): { count: number; unspent: bigint } {
    if (ent.status !== "active") return { count: 0, unspent: 0n };

    let count = 0;
    for (const child of this.childrenOf(ent.id)) {
      const r = this.terminate(child, now, reason);
      count += r.count;
    }

    // By now every child has already reclaimed its own unspent remainder
    // out of `amount_delegated` (see below), so what's left here is exactly
    // the total that was actually spent somewhere in the subtree.
    const unspent = ent.amount_granted - ent.amount_spent - ent.amount_delegated;
    ent.status = reason;

    if (ent.parent_id) {
      const parent = this.byId.get(ent.parent_id)!;
      parent.amount_delegated -= unspent;
    } else {
      this.ledger.returnToPool(ent.tenant_id, unspent);
    }

    return { count: count + 1, unspent };
  }

  revoke(id: string, now: number = Date.now()): { revoked_count: number; returned_amount: bigint } {
    const ent = this.byId.get(id);
    if (!ent) throw new Error(`Unknown entitlement: ${id}`);
    const { count, unspent } = this.terminate(ent, now, "revoked");
    return { revoked_count: count, returned_amount: unspent };
  }
}
