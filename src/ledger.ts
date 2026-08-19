// Ledger interface + in-memory implementation.
//
// Owns two independent kinds of bookkeeping:
//   1. Pool capital accounting (total / reserved / granted) — how much of a
//      tenant's pooled capital is free, hot-buffer-reserved by intents, or
//      committed out to root entitlements.
//   2. Double-entry settlement postings (invariant 8) — every settle() call
//      debits the paying agent's account and credits the counterparty's
//      account by equal amounts, so the ledger always nets to zero.
//
// Nothing outside this file mutates a Pool or posts ledger entries directly.

export type Currency = "USDC";

export type RejectionCode =
  | "ENTITLEMENT_EXPIRED"
  | "ENTITLEMENT_REVOKED"
  | "INSUFFICIENT_ENTITLEMENT"
  | "PARENT_INSUFFICIENT"
  | "EXPIRY_EXCEEDS_PARENT"
  | "COUNTERPARTY_NOT_ALLOWED"
  | "DELEGATION_TOO_DEEP"
  | "POOL_INSUFFICIENT";

/** Thrown for every permission-model rejection. `message === code`. */
export class TreasuryError extends Error {
  code: RejectionCode;
  constructor(code: RejectionCode) {
    super(code);
    this.name = "TreasuryError";
    this.code = code;
  }
}

export interface Pool {
  tenantId: string;
  currency: Currency;
  /** Total capital under management for this tenant. */
  total: bigint;
  /** Capital reserved by active intents against the hot buffer. */
  reserved: bigint;
  /** Capital currently committed to active root entitlements. */
  granted: bigint;
}

export interface LedgerEntry {
  id: string;
  settlementId: string;
  account: string;
  /** Signed minor-units delta: negative = debit, positive = credit. */
  amount: bigint;
  timestamp: number;
}

export interface Ledger {
  createPool(tenantId: string, total: bigint): Pool;
  getPool(tenantId: string): Pool;

  /** Commits `amount` of pool capital to a new root entitlement. */
  drawFromPool(tenantId: string, amount: bigint): void;
  /** Returns unspent root-entitlement capital to the pool. */
  returnToPool(tenantId: string, amount: bigint): void;

  /** Reserves `amount` against the pool's hot buffer for a declared intent. */
  reserveHotBuffer(tenantId: string, amount: bigint): void;
  /** Releases a hot-buffer reservation (intent consumed or expired). */
  releaseHotBuffer(tenantId: string, amount: bigint): void;

  poolUtilisation(tenantId: string): number;

  /** Posts a balanced double-entry pair for a settlement. */
  postSettlement(
    settlementId: string,
    debitAccount: string,
    creditAccount: string,
    amount: bigint,
    timestamp: number
  ): LedgerEntry[];

  getAccountBalance(account: string): bigint;
  getEntries(): LedgerEntry[];
  /** True iff every ledger entry ever posted still sums to zero. */
  isBalanced(): boolean;
}

let entryCounter = 0;
function nextEntryId(): string {
  entryCounter += 1;
  return `entry_${entryCounter}`;
}

export class InMemoryLedger implements Ledger {
  private pools = new Map<string, Pool>();
  private balances = new Map<string, bigint>();
  private entries: LedgerEntry[] = [];

  createPool(tenantId: string, total: bigint): Pool {
    const pool: Pool = { tenantId, currency: "USDC", total, reserved: 0n, granted: 0n };
    this.pools.set(tenantId, pool);
    return pool;
  }

  getPool(tenantId: string): Pool {
    const pool = this.pools.get(tenantId);
    if (!pool) throw new Error(`Unknown pool for tenant: ${tenantId}`);
    return pool;
  }

  private available(pool: Pool): bigint {
    return pool.total - pool.reserved - pool.granted;
  }

  drawFromPool(tenantId: string, amount: bigint): void {
    const pool = this.getPool(tenantId);
    if (amount > this.available(pool)) throw new TreasuryError("POOL_INSUFFICIENT");
    pool.granted += amount;
  }

  returnToPool(tenantId: string, amount: bigint): void {
    const pool = this.getPool(tenantId);
    pool.granted -= amount;
  }

  reserveHotBuffer(tenantId: string, amount: bigint): void {
    const pool = this.getPool(tenantId);
    if (amount > this.available(pool)) throw new TreasuryError("POOL_INSUFFICIENT");
    pool.reserved += amount;
  }

  releaseHotBuffer(tenantId: string, amount: bigint): void {
    const pool = this.getPool(tenantId);
    pool.reserved -= amount;
  }

  poolUtilisation(tenantId: string): number {
    const pool = this.getPool(tenantId);
    if (pool.total === 0n) return 0;
    const committed = pool.reserved + pool.granted;
    return Number(committed) / Number(pool.total);
  }

  postSettlement(
    settlementId: string,
    debitAccount: string,
    creditAccount: string,
    amount: bigint,
    timestamp: number
  ): LedgerEntry[] {
    const debit: LedgerEntry = {
      id: nextEntryId(),
      settlementId,
      account: debitAccount,
      amount: -amount,
      timestamp,
    };
    const credit: LedgerEntry = {
      id: nextEntryId(),
      settlementId,
      account: creditAccount,
      amount,
      timestamp,
    };
    this.entries.push(debit, credit);
    this.balances.set(debitAccount, (this.balances.get(debitAccount) ?? 0n) - amount);
    this.balances.set(creditAccount, (this.balances.get(creditAccount) ?? 0n) + amount);
    return [debit, credit];
  }

  getAccountBalance(account: string): bigint {
    return this.balances.get(account) ?? 0n;
  }

  getEntries(): LedgerEntry[] {
    return [...this.entries];
  }

  isBalanced(): boolean {
    return this.entries.reduce((sum, e) => sum + e.amount, 0n) === 0n;
  }
}
