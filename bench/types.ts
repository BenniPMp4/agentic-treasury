// Shared types for the counterfactual benchmark. Amounts are plain
// `number` minor units here (not bigint, unlike the ledger) — the
// benchmark is statistics (means, stddevs, percentiles) over a simulated
// fleet, not settlement bookkeeping, and JS floating-point arithmetic is
// itself deterministic given deterministic inputs, which is all invariant
// 16 requires. Every random draw in this tree goes through the seeded
// PRNG in bench/rng.ts — never Math.random() or Date.now().

export type Policy = "baseline" | "treasury" | "oracle";

export interface Scenario {
  name: string;
  description: string;
  agentCount: number;
  simulatedHours: number;
  tickMinutes: number;
  seed: number;
  poolTotal: number;
  /** Average spend events per agent per hour. */
  spendFrequencyPerHour: number;
  spendAmountMin: number;
  spendAmountMax: number;
  /** Fraction (0..1) of true spend events an agent correctly declares as
   * a COMMITTED intent, with the right amount and window. The rest are
   * either undeclared or declared with the wrong amount/timing. Only
   * `treasury` consumes this — baseline ignores intent entirely, oracle
   * has perfect knowledge of the ground truth regardless of what's
   * declared. */
  intentAccuracy: number;
  /** Simulation start, ISO — deliberately spans a weekend by default so
   * fund dealing cut-offs are exercised, not dodged. */
  startIso: string;
}

export interface SettlementRecord {
  agentId: string;
  requestedAtMs: number;
  settledAtMs: number;
  amount: number;
}

export interface BufferBreachRecord {
  timestampMs: number;
  required: number;
  available: number;
  shortfall: number;
}

export interface RejectionCounts {
  [code: string]: number;
}

export interface PolicyMetrics {
  policy: Policy;
  scenario: string;
  seed: number;
  /** Time-weighted mean fraction of total capital sitting in warm/cold
   * (yield-earning) tiers. */
  capitalEfficiencyMean: number;
  /** Time-weighted mean / peak fraction of capital sitting idle in hot. */
  idleFloatMean: number;
  idleFloatPeak: number;
  reclaimedCapital: number;
  realisedYield: number;
  settlementLatencyP50Ms: number;
  settlementLatencyP95Ms: number;
  settlementLatencyP99Ms: number;
  bufferBreachCount: number;
  bufferBreachTotalShortfall: number;
  rejections: RejectionCounts;
  spendCount: number;
  totalSpend: number;
}

export interface ScenarioRunResult {
  scenario: string;
  seed: number;
  policies: PolicyMetrics[];
}
