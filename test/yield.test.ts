// One test per new Phase 3 invariant (12-15), written before src/yield and
// src/intent exist — these are the spec, same convention as
// test/invariants.test.ts in Phase 1.
import { describe, expect, it } from "vitest";
import { apportionAccrual } from "../src/yield/accrual.js";
import { rebalanceToTarget, type TierBalances } from "../src/yield/allocation.js";
import { BufferGuard, requiredHotBuffer, DEFAULT_Z } from "../src/intent/buffer.js";
import { ReliabilityScorer, DEFAULT_RELIABILITY } from "../src/intent/reliability.js";
import { IntentEngine } from "../src/intent/engine.js";

describe("invariant 12: accrual apportionment sums exactly, no yield created or destroyed", () => {
  it("floor-then-largest-remainder shares sum to exactly the total accrual", () => {
    // 1000 minor units split 3 ways by weight 1:1:1 doesn't divide evenly.
    const shares = apportionAccrual(1000n, [
      { agent_id: "a", weight: 1n },
      { agent_id: "b", weight: 1n },
      { agent_id: "c", weight: 1n },
    ]);
    const sum = shares.reduce((s, x) => s + x.amount, 0n);
    expect(sum).toBe(1000n);
    // Documented rounding rule: floor shares get the leftover 1-unit
    // remainders distributed by largest fractional remainder, ties broken
    // by agent_id ascending. 1000/3 = 333 remainder 1 each (weights
    // equal, so all three remainders tie) -> the extra unit goes to "a".
    expect(shares.find((s) => s.agent_id === "a")?.amount).toBe(334n);
    expect(shares.find((s) => s.agent_id === "b")?.amount).toBe(333n);
    expect(shares.find((s) => s.agent_id === "c")?.amount).toBe(333n);
  });

  it("sums to exactly the total accrual across many random weight distributions (property check)", () => {
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let trial = 0; trial < 50; trial++) {
      const agentCount = 2 + Math.floor(rand() * 8);
      const weights = Array.from({ length: agentCount }, (_, i) => ({
        agent_id: `agent-${i}`,
        weight: BigInt(1 + Math.floor(rand() * 10_000)),
      }));
      const total = BigInt(Math.floor(rand() * 10_000_000));
      const shares = apportionAccrual(total, weights);
      const sum = shares.reduce((s, x) => s + x.amount, 0n);
      expect(sum).toBe(total);
      // No share is negative — apportionment never destroys or invents value per agent.
      expect(shares.every((s) => s.amount >= 0n)).toBe(true);
    }
  });

  it("apportions zero total accrual as all-zero shares, not an error", () => {
    const shares = apportionAccrual(0n, [
      { agent_id: "a", weight: 5n },
      { agent_id: "b", weight: 3n },
    ]);
    expect(shares.every((s) => s.amount === 0n)).toBe(true);
  });
});

describe("invariant 13: hot buffer must cover every COMMITTED intent in its window; breaches are recorded, never absorbed", () => {
  it("records a breach with the exact shortfall when available capital is insufficient", () => {
    const guard = new BufferGuard();
    const now = Date.parse("2026-03-02T10:00:00Z");

    const ok = guard.check(500n, 800n, now);
    expect(ok).toBe(false);
    const breaches = guard.getBreaches();
    expect(breaches).toHaveLength(1);
    expect(breaches[0]).toMatchObject({ required: 800n, available: 500n, shortfall: 300n, timestamp: now });
    expect(guard.totalShortfall()).toBe(300n);
  });

  it("does not record a breach when available capital exactly covers the requirement", () => {
    const guard = new BufferGuard();
    const ok = guard.check(800n, 800n, Date.now());
    expect(ok).toBe(true);
    expect(guard.getBreaches()).toHaveLength(0);
  });

  it("requiredHotBuffer's COMMITTED component is exact — no float rounding can round a real committed obligation down", () => {
    const engine = new IntentEngine();
    const now = Date.parse("2026-03-02T10:00:00Z");
    engine.declare({
      agent_id: "a",
      amount: 1_000_003n, // deliberately not a round number
      class: "COMMITTED",
      windowStart: now - 1000,
      windowEnd: now + 60_000,
    });
    const required = requiredHotBuffer({
      committedInWindow: engine.committedInWindow(now),
      probableIntents: [],
      reliabilityScore: () => 1,
      residualStddev: 0n,
    });
    expect(required).toBe(1_000_003n);
  });

  it("a breach is visible in the guard's record even though check() also returns a plain boolean — the record is the source of truth, not the return value", () => {
    const guard = new BufferGuard();
    // Caller could ignore the boolean return entirely; the breach must
    // still be durably recorded.
    guard.check(0n, 1n, Date.now());
    expect(guard.totalShortfall()).toBeGreaterThan(0n);
  });
});

describe("invariant 14: the allocation engine may never move capital in a way that would breach invariant 13", () => {
  it("moves only the surplus above the required hot buffer out of hot", () => {
    const current: TierBalances = { hot: 1000n, warm: 0n, cold: 0n };
    const result = rebalanceToTarget(current, 600n);
    expect(result.next.hot).toBeGreaterThanOrEqual(600n);
    expect(result.next.hot + result.next.warm + result.next.cold).toBe(1000n); // conserved
  });

  it("moves nothing when hot is already at or below the required buffer, even under a deficit", () => {
    const current: TierBalances = { hot: 400n, warm: 2000n, cold: 0n };
    const result = rebalanceToTarget(current, 800n); // hot is 400 short
    expect(result.next.hot).toBe(400n); // rebalance never moves hot -> hot deficit isn't its job
    expect(result.movedToWarm).toBe(0n);
  });

  it("across many random (current, required) pairs, the post-rebalance hot balance never drops below what was achievable without breaching", () => {
    let seed = 999;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let trial = 0; trial < 50; trial++) {
      const hot = BigInt(Math.floor(rand() * 100_000));
      const required = BigInt(Math.floor(rand() * 100_000));
      const current: TierBalances = { hot, warm: 0n, cold: 0n };
      const result = rebalanceToTarget(current, required);
      // Never moves hot below required *if it started at or above it*.
      if (hot >= required) {
        expect(result.next.hot).toBeGreaterThanOrEqual(required);
      } else {
        // Already in deficit — rebalance must not make it worse.
        expect(result.next.hot).toBe(hot);
      }
      expect(result.next.hot + result.next.warm + result.next.cold).toBe(hot); // conservation
    }
  });
});

describe("invariant 15: reliability scores are computed only from settled outcomes", () => {
  it("an agent with no settled history gets the conservative default, regardless of how many intents it has declared", () => {
    const scorer = new ReliabilityScorer();
    // Declaring intents happens through IntentEngine, which has no path
    // that touches ReliabilityScorer at all — there is no API for a mere
    // declaration to influence a score. Simulate a busy declarer:
    const engine = new IntentEngine();
    for (let i = 0; i < 20; i++) {
      engine.declare({
        agent_id: "prolific-declarer",
        amount: 100n,
        class: "PROBABLE",
        windowStart: Date.now(),
        windowEnd: Date.now() + 60_000,
      });
    }
    expect(scorer.score("prolific-declarer")).toBe(DEFAULT_RELIABILITY);
  });

  it("score moves only after recordSettledOutcome, and reflects the settled fulfilment rate exactly", () => {
    const scorer = new ReliabilityScorer();
    scorer.recordSettledOutcome("agent-x", true);
    scorer.recordSettledOutcome("agent-x", true);
    scorer.recordSettledOutcome("agent-x", false);
    // 2 of 3 settled outcomes were fulfilled as declared.
    expect(scorer.score("agent-x")).toBeCloseTo(2 / 3, 10);
  });

  it("an unrelated agent's declarations never leak into another agent's score", () => {
    const scorer = new ReliabilityScorer();
    scorer.recordSettledOutcome("agent-y", false);
    scorer.recordSettledOutcome("agent-y", false);
    expect(scorer.score("agent-z")).toBe(DEFAULT_RELIABILITY);
  });
});

// Not a numbered invariant, but PHASE3.md is explicit: "If the simulation
// runs a clean 24/7 cycle it is lying to you about the hardest case."
// This proves the weekend/cutoff modelling is real, not decorative.
describe("MockFund: dealing cut-offs and weekends are real, not decorative", () => {
  it("a redemption requested after Friday's cut-off doesn't settle until Monday's cycle", async () => {
    const { MockFund } = await import("../src/yield/fund.js");
    const fund = new MockFund();
    // Friday 2026-03-06, 16:00 UTC — after a 15:00 UTC cut-off.
    const afterFridayCutoff = Date.parse("2026-03-06T16:00:00Z");
    const settledAt = afterFridayCutoff + fund.settlementDelayMs(afterFridayCutoff);
    const settledDate = new Date(settledAt);
    // Must land on Monday 2026-03-09, not the weekend.
    expect(settledDate.getUTCDay()).toBe(1); // Monday
    expect(settledDate.getTime()).toBeGreaterThanOrEqual(Date.parse("2026-03-09T00:00:00Z"));
    // The gap really does span the full ~72h weekend, not a same-day cycle.
    expect(settledAt - afterFridayCutoff).toBeGreaterThan(60 * 60 * 60 * 1000);
  });

  it("a redemption requested well before cut-off on a weekday settles the same day", async () => {
    const { MockFund } = await import("../src/yield/fund.js");
    const fund = new MockFund();
    const beforeCutoff = Date.parse("2026-03-03T09:00:00Z"); // Tuesday morning
    const settledAt = beforeCutoff + fund.settlementDelayMs(beforeCutoff);
    expect(new Date(settledAt).getUTCDate()).toBe(new Date(beforeCutoff).getUTCDate());
  });
});
