// npm run bench — PHASE3.md deliverable C's entry point.
//
// 1. Runs baseline/treasury/oracle against every committed scenario,
//    same seed each, and writes results/summary.{json,csv} plus a
//    plain-text table to stdout.
// 2. Runs the intent-accuracy sensitivity sweep (0% -> 100%) for
//    `treasury` against every scenario, holding everything else fixed,
//    and writes results/sensitivity.{json,csv} — "the most valuable
//    output of this entire project" per PHASE3.md.
//
// No plotting library: CSV out, let the reader chart it.
import { readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runScenario } from "./simulate.js";
import type { PolicyMetrics, Policy, Scenario } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIOS_DIR = path.join(__dirname, "scenarios");
const RESULTS_DIR = path.join(__dirname, "results");

const POLICIES: Policy[] = ["baseline", "treasury", "oracle"];
const SWEEP_STEPS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];

function loadScenarios(): Scenario[] {
  return readdirSync(SCENARIOS_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(path.join(SCENARIOS_DIR, f), "utf8")) as Scenario);
}

function csvEscape(value: unknown): string {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]!);
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h])).join(","));
  }
  return lines.join("\n") + "\n";
}

function metricsRow(m: PolicyMetrics): Record<string, unknown> {
  return {
    scenario: m.scenario,
    policy: m.policy,
    seed: m.seed,
    capital_efficiency_mean: m.capitalEfficiencyMean.toFixed(6),
    idle_float_mean: m.idleFloatMean.toFixed(6),
    idle_float_peak: m.idleFloatPeak.toFixed(6),
    reclaimed_capital: m.reclaimedCapital,
    realised_yield: m.realisedYield.toFixed(2),
    settlement_latency_p50_ms: m.settlementLatencyP50Ms,
    settlement_latency_p95_ms: m.settlementLatencyP95Ms,
    settlement_latency_p99_ms: m.settlementLatencyP99Ms,
    buffer_breach_count: m.bufferBreachCount,
    buffer_breach_total_shortfall: m.bufferBreachTotalShortfall,
    rejections: JSON.stringify(m.rejections),
    spend_count: m.spendCount,
    total_spend: m.totalSpend,
  };
}

function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  return [line(headers), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(line)].join("\n");
}

function runMain(): void {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const scenarios = loadScenarios();

  // --- Part 1: baseline / treasury / oracle across every scenario ------
  const allMetrics: PolicyMetrics[] = [];
  for (const scenario of scenarios) {
    for (const policy of POLICIES) {
      allMetrics.push(runScenario(scenario, policy));
    }
  }

  writeFileSync(path.join(RESULTS_DIR, "summary.json"), JSON.stringify(allMetrics, null, 2) + "\n");
  writeFileSync(path.join(RESULTS_DIR, "summary.csv"), toCsv(allMetrics.map(metricsRow)));

  console.log("=".repeat(78));
  console.log("Agent Treasury — counterfactual benchmark");
  console.log("=".repeat(78));
  console.log(
    formatTable(
      ["scenario", "policy", "capital_eff", "idle_mean", "breaches", "p50_latency_ms", "rejections"],
      allMetrics.map((m) => [
        m.scenario,
        m.policy,
        `${(m.capitalEfficiencyMean * 100).toFixed(1)}%`,
        `${(m.idleFloatMean * 100).toFixed(1)}%`,
        String(m.bufferBreachCount),
        String(m.settlementLatencyP50Ms),
        String(Object.values(m.rejections).reduce((s, n) => s + n, 0)),
      ])
    )
  );

  // --- Part 2: intent-accuracy sensitivity sweep, treasury only --------
  interface SweepRow {
    scenario: string;
    intent_accuracy: number;
    capital_efficiency_mean: number;
    oracle_capital_efficiency: number;
    pct_of_oracle: number;
    buffer_breach_count: number;
  }
  const sweepRows: SweepRow[] = [];
  for (const scenario of scenarios) {
    const oracle = runScenario(scenario, "oracle");
    for (const intentAccuracy of SWEEP_STEPS) {
      const t = runScenario({ ...scenario, intentAccuracy }, "treasury");
      sweepRows.push({
        scenario: scenario.name,
        intent_accuracy: intentAccuracy,
        capital_efficiency_mean: t.capitalEfficiencyMean,
        oracle_capital_efficiency: oracle.capitalEfficiencyMean,
        pct_of_oracle: oracle.capitalEfficiencyMean === 0 ? 0 : t.capitalEfficiencyMean / oracle.capitalEfficiencyMean,
        buffer_breach_count: t.bufferBreachCount,
      });
    }
  }

  writeFileSync(path.join(RESULTS_DIR, "sensitivity.json"), JSON.stringify(sweepRows, null, 2) + "\n");
  writeFileSync(
    path.join(RESULTS_DIR, "sensitivity.csv"),
    toCsv(
      sweepRows.map((r) => ({
        scenario: r.scenario,
        intent_accuracy: r.intent_accuracy,
        capital_efficiency_mean: r.capital_efficiency_mean.toFixed(6),
        oracle_capital_efficiency: r.oracle_capital_efficiency.toFixed(6),
        pct_of_oracle: r.pct_of_oracle.toFixed(6),
        buffer_breach_count: r.buffer_breach_count,
      }))
    )
  );

  console.log("\n" + "=".repeat(78));
  console.log("Intent-accuracy sensitivity sweep (capital efficiency as % of the oracle ceiling)");
  console.log("=".repeat(78));
  console.log(
    formatTable(
      ["scenario", "intent_accuracy", "capital_eff", "pct_of_oracle", "breaches"],
      sweepRows.map((r) => [
        r.scenario,
        `${(r.intent_accuracy * 100).toFixed(0)}%`,
        `${(r.capital_efficiency_mean * 100).toFixed(1)}%`,
        `${(r.pct_of_oracle * 100).toFixed(1)}%`,
        String(r.buffer_breach_count),
      ])
    )
  );

  console.log(`\nResults written to ${RESULTS_DIR}`);
}

runMain();
