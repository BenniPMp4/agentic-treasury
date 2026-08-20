// The three policies, one shared tick loop for the pooled ones
// (treasury/oracle), all driven from the exact same generateDemand()
// output for a given scenario+seed. Reuses the actual Phase 3 B modules
// (MockFund, rebalanceToTarget, requiredHotBuffer, BufferGuard,
// apportionAccrual, ReliabilityScorer) rather than re-deriving their
// logic — the benchmark measures the real mechanism, not a stand-in for it.
import { generateDemand, type Demand } from "./demand.js";
import { mean, percentile, stddev } from "./metrics.js";
import { mulberry32 } from "./rng.js";
import type { Policy, PolicyMetrics, RejectionCounts, Scenario } from "./types.js";
import { MockFund } from "../src/yield/fund.js";
import { rebalanceToTarget, type TierBalances } from "../src/yield/allocation.js";
import { requiredHotBuffer, BufferGuard } from "../src/intent/buffer.js";
import { apportionAccrual } from "../src/yield/accrual.js";
import { ReliabilityScorer } from "../src/intent/reliability.js";

const MS_PER_YEAR = 365 * 24 * 3_600_000;

/**
 * A redemption requested at `now` only lands at the *next* dealing
 * cut-off — it can never help with spend that happens before that
 * cut-off (dealing is a discrete daily event, not a continuous
 * function of "how long ago you asked"). So the amount that needs to
 * be *already* hot right now isn't "spend within one settlement delay"
 * — a request made right now can't retroactively cover any of that —
 * it's spend within one delay *plus the delay of the cycle after that*,
 * since that's the earliest a *fresh* request made right now could
 * possibly help, and everything before it has to already be covered.
 * This is what makes the Friday-afternoon case work out to a real ~72h
 * of pre-positioned hot capital, not just the ~72h delay figure itself
 * misapplied as a lookahead radius.
 */
function safeLookaheadMs(fund: MockFund, now: number): number {
  const firstCycle = fund.settlementDelayMs(now);
  const secondCycle = fund.settlementDelayMs(now + firstCycle);
  return firstCycle + secondCycle;
}

const CAPITAL_UNAVAILABLE = "CAPITAL_UNAVAILABLE";
/** How much history the causal residual-volatility estimate keeps —
 * needs to comfortably exceed the largest possible vulnerability window
 * (a weekend, ~72h) so there's always enough history to estimate against,
 * while still only ever looking at the past. */
const RESIDUAL_HISTORY_MS = 9 * 24 * 3_600_000;

interface TierSample {
  hot: number;
  warm: number;
  cold: number;
}

function emptyMetrics(policy: Policy, scenario: Scenario): PolicyMetrics {
  return {
    policy,
    scenario: scenario.name,
    seed: scenario.seed,
    capitalEfficiencyMean: 0,
    idleFloatMean: 0,
    idleFloatPeak: 0,
    reclaimedCapital: 0,
    realisedYield: 0,
    settlementLatencyP50Ms: 0,
    settlementLatencyP95Ms: 0,
    settlementLatencyP99Ms: 0,
    bufferBreachCount: 0,
    bufferBreachTotalShortfall: 0,
    rejections: {},
    spendCount: 0,
    totalSpend: 0,
  };
}

function finalise(
  policy: Policy,
  scenario: Scenario,
  samples: TierSample[],
  latencies: number[],
  guard: BufferGuard,
  rejections: RejectionCounts,
  spendCount: number,
  totalSpend: number,
  reclaimedCapital: number,
  realisedYield: number
): PolicyMetrics {
  const totalCapital = scenario.poolTotal;
  const sortedLatencies = [...latencies].sort((a, b) => a - b);
  return {
    policy,
    scenario: scenario.name,
    seed: scenario.seed,
    capitalEfficiencyMean: mean(samples.map((s) => (s.warm + s.cold) / totalCapital)),
    idleFloatMean: mean(samples.map((s) => s.hot / totalCapital)),
    idleFloatPeak: samples.length === 0 ? 0 : Math.max(...samples.map((s) => s.hot / totalCapital)),
    reclaimedCapital,
    realisedYield,
    settlementLatencyP50Ms: percentile(sortedLatencies, 0.5),
    settlementLatencyP95Ms: percentile(sortedLatencies, 0.95),
    settlementLatencyP99Ms: percentile(sortedLatencies, 0.99),
    bufferBreachCount: guard.getBreaches().length,
    bufferBreachTotalShortfall: Number(guard.totalShortfall()),
    rejections,
    spendCount,
    totalSpend,
  };
}

/** Shared by treasury and oracle: pooled capital, hot/warm/cold tiers,
 * real dealing-cutoff-aware redemption delay on a hot shortfall. They
 * differ only in how each ticks sizes the required hot buffer. */
function runPooled(scenario: Scenario, policy: "treasury" | "oracle", demand: Demand): PolicyMetrics {
  const startMs = Date.parse(scenario.startIso);
  const endMs = startMs + scenario.simulatedHours * 3_600_000;
  const tickMs = scenario.tickMinutes * 60_000;
  const fund = new MockFund({ epochMs: startMs });

  let state: TierBalances = { hot: BigInt(scenario.poolTotal), warm: 0n, cold: 0n };
  const guard = new BufferGuard();
  const reliability = new ReliabilityScorer();
  const rejections: RejectionCounts = {};
  const latencies: number[] = [];
  const samples: TierSample[] = [];

  // Seeded with a scenario-derived prior (not zero) so treasury doesn't
  // spend its first ~72h flying blind before real history accumulates —
  // a real system also wouldn't start from literally no information, it
  // would start from a forecast. Only ever the mean is assumed a priori;
  // the estimated spread starts at zero and grows from real observations.
  const priorUndeclaredPerTick =
    scenario.agentCount *
    scenario.spendFrequencyPerHour *
    (tickMs / 3_600_000) *
    (1 - scenario.intentAccuracy) *
    ((scenario.spendAmountMin + scenario.spendAmountMax) / 2);
  const priorSampleCount = Math.max(1, Math.ceil(safeLookaheadMs(fund, startMs) / tickMs));
  const residualWindow: number[] = new Array(priorSampleCount).fill(priorUndeclaredPerTick);

  let realisedYield = 0;
  let reclaimedCapital = 0;
  let spendCount = 0;
  let totalSpend = 0;
  const settledByAgent = new Map<string, bigint>();

  // `declared` sorted by windowStart (due time). committedPtr only ever
  // advances past items whose due time is now in the past — a forward
  // lookahead sum can never need one of those again regardless of how
  // wide the lookahead gets — so each tick rescans forward from there
  // to wherever the *current* lookahead ends. This is the same "sum of
  // what's due within the lookahead horizon" query oracle runs against
  // ground truth (below); this is the noisy, declared-only version of it
  // — a fixed-width SlidingWindowSum over each item's own narrow
  // execution window would answer "is something due right now", not
  // "how much is due soon", which is what buffer sizing actually needs.
  const declared = demand.declared;
  let committedPtr = 0;
  // Second pass over the same declared list, purely to detect window
  // closure for reclaimedCapital bookkeeping (declared surplus over
  // what was actually spent, once the window has fully elapsed).
  let reclaimPtr = 0;

  let spendIdx = 0;
  const spends = demand.spends;

  // Redemptions requested ahead of predicted need, in flight until the
  // fund's dealing delay elapses. Money leaves warm/cold the instant it's
  // requested (it stops earning yield immediately, realistically) but
  // only becomes spendable hot capital on arrival — this is what makes
  // "proactively topping hot back up" different from "instantly moving
  // it," and what gives genuinely-surprised demand (imperfect intent, or
  // simply oracle's own lookahead window ending) a real, measured latency
  // instead of either an instant fix or a permanent one.
  const pendingRedemptions: { arrivesAtMs: number; amount: bigint }[] = [];

  for (let now = startMs; now < endMs; now += tickMs) {
    // 0. Credit any redemptions that have arrived by now.
    while (pendingRedemptions.length > 0 && pendingRedemptions[0]!.arrivesAtMs <= now) {
      const arrived = pendingRedemptions.shift()!;
      state = { ...state, hot: state.hot + arrived.amount };
    }

    // 1. Size hot for this tick.
    let requiredHot: bigint;
    if (policy === "oracle") {
      const lookaheadMs = safeLookaheadMs(fund, now);
      let sum = 0;
      for (let i = spendIdx; i < spends.length; i++) {
        const s = spends[i]!;
        if (s.atMs > now + lookaheadMs) break; // sorted by atMs
        sum += s.amount;
      }
      requiredHot = BigInt(Math.round(sum));
    } else {
      const lookaheadMs = safeLookaheadMs(fund, now);
      while (committedPtr < declared.length && declared[committedPtr]!.windowStart < now) committedPtr++;
      let committed = 0;
      for (let i = committedPtr; i < declared.length; i++) {
        const d = declared[i]!;
        if (d.windowStart > now + lookaheadMs) break; // sorted by windowStart
        committed += d.amount;
      }

      // The undeclared-spend buffer has to cover the *whole* vulnerability
      // window — the time until hot could next be topped up from a
      // redemption, which is exactly fund.settlementDelayMs(now) and can
      // be ~72h over a weekend, not just "the next tick". A per-tick
      // stddev alone chronically under-buffers by orders of magnitude
      // whenever that window is more than one tick wide: for N
      // (roughly-)independent ticks, the sum's mean scales with N and its
      // stddev scales with sqrt(N), not N — both matter here.
      const windowTicks = Math.max(1, Math.round(lookaheadMs / tickMs));
      const recentTicks = residualWindow.slice(-windowTicks);
      const tickMean = mean(recentTicks);
      const tickStddev = stddev(recentTicks);
      const expectedUndeclaredExposure = tickMean * windowTicks;
      const undeclaredTailStddev = tickStddev * Math.sqrt(windowTicks);

      requiredHot = requiredHotBuffer({
        committedInWindow: BigInt(Math.round(committed + expectedUndeclaredExposure)),
        probableIntents: [],
        reliabilityScore: () => 1,
        residualStddev: BigInt(Math.round(undeclaredTailStddev)),
      });
    }

    // 1b. If projected hot (current + already in flight) falls short of
    // what's required, proactively request a redemption for the deficit
    // now, so it has the best chance of landing before it's needed.
    // rebalanceToTarget (below) only ever trims surplus *out* of hot — by
    // design (invariant 14) it never brings capital in, so this is the
    // only path that replenishes hot at all.
    const pendingTotal = pendingRedemptions.reduce((s, p) => s + p.amount, 0n);
    const projectedHot = state.hot + pendingTotal;
    if (projectedHot < requiredHot) {
      const need = requiredHot - projectedHot;
      const fromWarm = need <= state.warm ? need : state.warm;
      const fromCold = need - fromWarm > state.cold ? state.cold : need - fromWarm;
      const redeemed = fromWarm + fromCold;
      if (redeemed > 0n) {
        state = { ...state, warm: state.warm - fromWarm, cold: state.cold - fromCold };
        pendingRedemptions.push({ arrivesAtMs: now + fund.settlementDelayMs(now), amount: redeemed });
        pendingRedemptions.sort((a, b) => a.arrivesAtMs - b.arrivesAtMs);
      }
    }

    const rebalanced = rebalanceToTarget(state, requiredHot);
    state = rebalanced.next;

    // 2. Accrue yield on warm+cold this tick; it compounds into cold
    // (the long-horizon tier) rather than sitting idle in hot.
    const rateBps = fund.currentRateBps(now);
    const tickYield = (Number(state.warm + state.cold) * (rateBps / 10_000) * tickMs) / MS_PER_YEAR;
    realisedYield += tickYield;
    state = { ...state, cold: state.cold + BigInt(Math.round(tickYield)) };

    samples.push({ hot: Number(state.hot), warm: Number(state.warm), cold: Number(state.cold) });

    // 3. Reclaim capital from declarations whose window has just closed.
    while (reclaimPtr < demand.declared.length && demand.declared[reclaimPtr]!.windowEnd < now) {
      const d = demand.declared[reclaimPtr]!;
      reclaimedCapital += Math.max(0, d.amount - d.trueAmount);
      reclaimPtr++;
    }

    // 4. Process true spends landing in this tick.
    let tickUndeclared = 0;
    while (spendIdx < spends.length && spends[spendIdx]!.atMs < now + tickMs) {
      const spend = spends[spendIdx]!;
      spendIdx++;
      const amount = BigInt(spend.amount);
      const hotBefore = state.hot;
      const ok = guard.check(hotBefore, amount, spend.atMs);

      if (ok) {
        state = { ...state, hot: state.hot - amount };
        latencies.push(0);
        spendCount++;
        totalSpend += spend.amount;
        reliability.recordSettledOutcome(spend.agentId, true);
        settledByAgent.set(spend.agentId, (settledByAgent.get(spend.agentId) ?? 0n) + amount);
      } else {
        const shortfall = amount - hotBefore;
        const available = hotBefore + state.warm + state.cold;
        if (available < amount) {
          rejections[CAPITAL_UNAVAILABLE] = (rejections[CAPITAL_UNAVAILABLE] ?? 0) + 1;
          reliability.recordSettledOutcome(spend.agentId, false);
        } else {
          const fromWarm = shortfall <= state.warm ? shortfall : state.warm;
          const fromCold = shortfall - fromWarm;
          state = { hot: 0n, warm: state.warm - fromWarm, cold: state.cold - fromCold };
          latencies.push(fund.settlementDelayMs(spend.atMs));
          spendCount++;
          totalSpend += spend.amount;
          reliability.recordSettledOutcome(spend.agentId, true);
          settledByAgent.set(spend.agentId, (settledByAgent.get(spend.agentId) ?? 0n) + amount);
        }
      }

      if (!spend.wasDeclared) tickUndeclared += spend.amount;
    }

    residualWindow.push(tickUndeclared);
    const residualHistoryTicks = Math.ceil(RESIDUAL_HISTORY_MS / tickMs);
    if (residualWindow.length > residualHistoryTicks) residualWindow.shift();
  }

  // Apportion the realised yield across agents by their settled-spend
  // share, using the real invariant-12 apportionment function — the
  // benchmark only reports the pool-level total, but this exercises the
  // exact-sum guarantee end to end against real per-run numbers rather
  // than only in isolation in test/yield.test.ts. A mismatch here would
  // mean invariant 12 doesn't actually hold in practice, not just in
  // unit tests — fail loudly rather than silently ignore that.
  if (settledByAgent.size > 0) {
    const weights = [...settledByAgent.entries()].map(([agent_id, weight]) => ({ agent_id, weight }));
    const shares = apportionAccrual(BigInt(Math.round(realisedYield)), weights);
    const apportionedSum = shares.reduce((s, x) => s + x.amount, 0n);
    if (apportionedSum !== BigInt(Math.round(realisedYield))) {
      throw new Error(
        `invariant 12 violated: apportioned yield ${apportionedSum} != realised yield ${Math.round(realisedYield)}`
      );
    }
  }

  return finalise(
    policy,
    scenario,
    samples,
    latencies,
    guard,
    rejections,
    spendCount,
    totalSpend,
    reclaimedCapital,
    realisedYield
  );
}

/** Wallet per agent, static prefunding, no intent, no pooling — what
 * people do today. Each agent gets an equal share of the pool as a
 * standalone, fully-liquid wallet; nothing is ever invested, so capital
 * efficiency is definitionally zero. A wallet that runs dry rejects
 * further spends outright (no cross-agent pooling to draw from) — a real,
 * un-strawmanned consequence of no pooling, not an artefact of
 * under-funding it. */
function runBaseline(scenario: Scenario, demand: Demand): PolicyMetrics {
  const perAgentWallet = scenario.poolTotal / scenario.agentCount;
  const wallets = new Map<string, number>();
  const rejections: RejectionCounts = {};
  let spendCount = 0;
  let totalSpend = 0;

  for (const spend of demand.spends) {
    const balance = wallets.get(spend.agentId) ?? perAgentWallet;
    if (balance >= spend.amount) {
      wallets.set(spend.agentId, balance - spend.amount);
      spendCount++;
      totalSpend += spend.amount;
    } else {
      rejections[CAPITAL_UNAVAILABLE] = (rejections[CAPITAL_UNAVAILABLE] ?? 0) + 1;
    }
  }

  const metrics = emptyMetrics("baseline", scenario);
  metrics.idleFloatMean = 1;
  metrics.idleFloatPeak = 1;
  metrics.capitalEfficiencyMean = 0;
  metrics.rejections = rejections;
  metrics.spendCount = spendCount;
  metrics.totalSpend = totalSpend;
  return metrics;
}

export function runScenario(scenario: Scenario, policy: Policy): PolicyMetrics {
  const demand = generateDemand(scenario);
  if (policy === "baseline") return runBaseline(scenario, demand);
  return runPooled(scenario, policy, demand);
}

/** Just confirms the seeded RNG is actually wired end to end — not used
 * by runScenario itself, exported for tests/tools that want a quick
 * sanity draw without spinning up a full scenario. */
export function sampleRng(seed: number, n: number): number[] {
  const rng = mulberry32(seed);
  return Array.from({ length: n }, () => rng());
}
