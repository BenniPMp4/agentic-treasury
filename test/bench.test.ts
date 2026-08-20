// Invariant 16, and the very first thing written for deliverable C, before
// any scenario code exists: "The benchmark harness is deterministic:
// identical seed produces byte-identical output. Without this the
// benchmark is worthless." (PHASE3.md)
import { describe, expect, it } from "vitest";
import { runScenario } from "../bench/simulate.js";
import type { Scenario } from "../bench/types.js";

const scenario: Scenario = {
  name: "determinism-check",
  description: "small synthetic scenario, only used to prove determinism",
  agentCount: 20,
  simulatedHours: 48,
  tickMinutes: 15,
  seed: 777,
  poolTotal: 1_000_000,
  spendFrequencyPerHour: 2,
  spendAmountMin: 5,
  spendAmountMax: 200,
  intentAccuracy: 0.8,
  startIso: "2026-03-02T00:00:00Z", // a Monday, spans the following weekend
};

describe("invariant 16: the benchmark harness is deterministic", () => {
  it.each(["baseline", "treasury", "oracle"] as const)(
    "identical seed produces byte-identical output for policy=%s",
    (policy) => {
      const a = runScenario(scenario, policy);
      const b = runScenario(scenario, policy);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
  );

  it("running the exact same scenario+policy three times in a row never drifts", () => {
    const runs = [1, 2, 3].map(() => JSON.stringify(runScenario(scenario, "treasury")));
    expect(runs[1]).toBe(runs[0]);
    expect(runs[2]).toBe(runs[0]);
  });

  it("a different seed produces different output — determinism isn't hiding a constant", () => {
    const a = JSON.stringify(runScenario(scenario, "treasury"));
    const b = JSON.stringify(runScenario({ ...scenario, seed: scenario.seed + 1 }, "treasury"));
    expect(a).not.toBe(b);
  });

  it("the three policies produce different metrics from the same seed (they're not accidentally identical)", () => {
    const baseline = runScenario(scenario, "baseline");
    const treasury = runScenario(scenario, "treasury");
    const oracle = runScenario(scenario, "oracle");
    expect(JSON.stringify(baseline)).not.toBe(JSON.stringify(treasury));
    expect(JSON.stringify(treasury)).not.toBe(JSON.stringify(oracle));
  });
});
