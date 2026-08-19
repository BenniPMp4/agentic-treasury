// Declare, reserve, expire. Enforces invariant 9.
import type { Ledger } from "./ledger.js";
import { TreasuryError } from "./ledger.js";
import type { EntitlementStore } from "./entitlements.js";

export type IntentClass = "COMMITTED" | "PROBABLE" | "SPECULATIVE";
export type IntentStatus = "active" | "expired" | "consumed" | "released";

export interface Intent {
  id: string;
  entitlement_id: string;
  tenant_id: string;
  amount: bigint;
  class: IntentClass;
  earliest: number | null;
  latest: number;
  counterparty_class: string | null;
  status: IntentStatus;
}

export interface DeclareIntentParams {
  entitlement_id: string;
  amount: bigint;
  class: IntentClass;
  earliest?: number;
  latest?: number;
  counterparty_class?: string;
}

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `int_${idCounter}`;
}

export class IntentStore {
  private byId = new Map<string, Intent>();

  constructor(private ledger: Ledger, private entitlements: EntitlementStore) {}

  declare(params: DeclareIntentParams, now: number = Date.now()): { intent_id: string; reserved: bigint } {
    const ent = this.entitlements.get(params.entitlement_id, now);
    if (ent.status === "expired") throw new TreasuryError("ENTITLEMENT_EXPIRED");
    if (ent.status === "revoked") throw new TreasuryError("ENTITLEMENT_REVOKED");

    const available = ent.amount_granted - ent.amount_spent - ent.amount_delegated;
    if (params.amount > available) throw new TreasuryError("INSUFFICIENT_ENTITLEMENT");

    // Intents reserve against the Pool's hot buffer only — amount_granted
    // on the entitlement is never touched (invariant 9).
    this.ledger.reserveHotBuffer(ent.tenant_id, params.amount);

    const intent: Intent = {
      id: nextId(),
      entitlement_id: ent.id,
      tenant_id: ent.tenant_id,
      amount: params.amount,
      class: params.class,
      earliest: params.earliest ?? null,
      latest: params.latest ?? ent.expires_at,
      counterparty_class: params.counterparty_class ?? null,
      status: "active",
    };
    this.byId.set(intent.id, intent);

    return { intent_id: intent.id, reserved: params.amount };
  }

  get(id: string, now: number = Date.now()): Intent {
    this.releaseIfExpired(id, now);
    const intent = this.byId.get(id);
    if (!intent) throw new Error(`Unknown intent: ${id}`);
    return intent;
  }

  /** Releases the hot-buffer reservation if the intent is past its `latest`. */
  releaseIfExpired(id: string, now: number = Date.now()): boolean {
    const intent = this.byId.get(id);
    if (!intent) throw new Error(`Unknown intent: ${id}`);
    if (intent.status === "active" && now >= intent.latest) {
      this.ledger.releaseHotBuffer(intent.tenant_id, intent.amount);
      intent.status = "expired";
      return true;
    }
    return false;
  }

  /** Marks an intent consumed by a settlement and releases its reservation. */
  consume(id: string): Intent {
    const intent = this.byId.get(id);
    if (!intent) throw new Error(`Unknown intent: ${id}`);
    if (intent.status === "active") {
      this.ledger.releaseHotBuffer(intent.tenant_id, intent.amount);
    }
    intent.status = "consumed";
    return intent;
  }
}
