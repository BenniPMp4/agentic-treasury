// Deterministic ground-truth demand generation, shared unchanged across
// all three policies for a given scenario+seed — fairness requires that
// baseline/treasury/oracle face the *same* spend events, differing only
// in how each provisions capital ahead of them. `declared` is a noisy
// view of `spends`: only `treasury` (and only causally — see
// bench/policies/treasury.ts) is allowed to use it; `oracle` sees
// `spends` directly, `baseline` ignores both.
import { mulberry32 } from "./rng.js";
import type { Scenario } from "./types.js";

export interface SpendEvent {
  agentId: string;
  atMs: number;
  /** Integer minor units — see bench/types.ts module comment. */
  amount: number;
  /** Whether this exact spend was correctly declared ahead of time —
   * recorded at generation time, not reconstructed later by matching
   * against `declared` (which would be O(spends x declared) over a whole
   * run). */
  wasDeclared: boolean;
}

export interface DeclaredIntent {
  agentId: string;
  /** The declared amount — sometimes inflated above what's actually
   * spent (agents over-ask), which is exactly what makes
   * `reclaimedCapital` a meaningful, non-trivially-zero metric. */
  amount: number;
  /** What actually got spent against this declaration. amount >= trueAmount always. */
  trueAmount: number;
  windowStart: number;
  windowEnd: number;
}

export interface Demand {
  spends: SpendEvent[];
  declared: DeclaredIntent[];
}

const DECLARATION_WINDOW_MS = 30 * 60_000; // +-30 min around the true spend time

export function generateDemand(scenario: Scenario): Demand {
  const rng = mulberry32(scenario.seed);
  const startMs = Date.parse(scenario.startIso);
  const endMs = startMs + scenario.simulatedHours * 3_600_000;
  const meanGapMs = 3_600_000 / scenario.spendFrequencyPerHour;

  const spends: SpendEvent[] = [];
  const declared: DeclaredIntent[] = [];

  for (let a = 0; a < scenario.agentCount; a++) {
    const agentId = `agent-${a}`;
    let t = startMs;
    for (;;) {
      // Exponential inter-arrival times -> a Poisson process at the
      // scenario's target frequency; deterministic given `rng`.
      const gap = -Math.log(1 - rng()) * meanGapMs;
      t += gap;
      if (t >= endMs) break;

      const amount = Math.round(
        scenario.spendAmountMin + rng() * (scenario.spendAmountMax - scenario.spendAmountMin)
      );
      const atMs = Math.round(t);
      const wasDeclared = rng() < scenario.intentAccuracy;
      spends.push({ agentId, atMs, amount, wasDeclared });

      if (wasDeclared) {
        // ~30% of the time an agent over-declares by up to 50% extra —
        // realistic, and the only honest source of a non-zero
        // reclaimedCapital metric: capital committed to a declaration
        // that the actual settled spend never fully used.
        const overDeclare = rng() < 0.3 ? Math.round(amount * rng() * 0.5) : 0;
        declared.push({
          agentId,
          amount: amount + overDeclare,
          trueAmount: amount,
          windowStart: atMs - DECLARATION_WINDOW_MS,
          windowEnd: atMs + DECLARATION_WINDOW_MS,
        });
      }
      // else: this spend goes entirely undeclared — treasury only ever
      // learns about it from the causal residual-volatility estimate.
    }
  }

  spends.sort((x, y) => x.atMs - y.atMs || (x.agentId < y.agentId ? -1 : 1));
  declared.sort((x, y) => x.windowStart - y.windowStart || (x.agentId < y.agentId ? -1 : 1));

  return { spends, declared };
}
