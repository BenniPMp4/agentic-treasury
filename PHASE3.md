# PHASE3.md — Yield, Intent, and the Counterfactual Benchmark

Read alongside CLAUDE.md and PHASE2.md. All prior invariants (1–11) still apply unchanged.

Phase 3 is where the thesis becomes **measurable**. Phases 1 and 2 built a mechanism; this one produces the evidence that the mechanism is worth anything.

---

## Three deliverables

**A. A real, installable MCP server.** Today it is a library with tests. It needs to be something a person adds to Claude Desktop in one step.

**B. The yield layer.** Fund adapter, tiered allocation, per-agent accrual apportionment, intent-driven buffer sizing.

**C. The counterfactual benchmark.** A deterministic, reproducible harness that measures what the entitlement model is actually worth against a fair baseline and a theoretical ceiling.

C is the point. A and B exist to make C credible.

---

## New invariants

**12.** Accrual apportionment across agents sums exactly to the pool's total accrual. No yield is created or destroyed by attribution. Test with exact integer arithmetic; document the rounding rule for the residual.

**13.** The hot buffer must at all times cover every `COMMITTED` intent inside its execution window. A breach is recorded, never silently absorbed.

**14.** The allocation engine may never move capital in a way that would breach invariant 13.

**15.** Reliability scores are computed only from **settled outcomes**. A declaration alone never improves a score.

**16.** The benchmark harness is deterministic: identical seed produces byte-identical output. Without this the benchmark is worthless.

---

## A. Shipping the MCP server

- stdio transport, `bin` entry in `package.json`, runnable via `npx`
- The three `treasury://` resources fully implemented, not stubbed
- Rejection codes surfaced as structured MCP errors carrying enough context to retry — code, entitlement id, available amount
- `README.md` with a copy-pasteable `claude_desktop_config.json` block
- A `sim` mode flag so someone can install and explore against a simulated fleet without any chain or credentials

**Done when** a person who has never seen the repo can install it and have an agent request a budget, delegate, overspend and get rejected — in under five minutes.

---

## B. Yield layer

```
src/yield/
  fund.ts        FundAdapter interface + MockFund with deterministic NAV
  allocation.ts  Hot / warm / cold tiering
  accrual.ts     Per-agent, per-second apportionment
src/intent/
  engine.ts      Declare, reserve, expire
  reliability.ts Per-agent scoring from settled outcomes
  buffer.ts      Required hot balance
```

**FundAdapter must be an interface with a mock implementation.** No real provider. Spiko and Archax slot in behind it later; nothing above this layer may know which fund it is talking to.

**Tiers:**

```
HOT    instant, zero yield        sized by buffer engine
WARM   same-day dealing cycle     bulk of capital
COLD   multi-day                  long-horizon entitlements and escrow
```

Model dealing cut-offs explicitly. A redemption requested after cut-off settles next cycle. **Weekends and bank holidays must be modelled** — funds don't deal, agents don't stop, and the buffer has to carry 72 hours. If the simulation runs a clean 24/7 cycle it is lying to you about the hardest case.

**Buffer formula:**

```
Hot = Σ(COMMITTED in window)
    + Σ(PROBABLE × p × reliability_score(agent))
    + z · σ(undeclared residual)
```

`z` configurable. Default to a conservative value and let the benchmark sweep it.

---

## C. The counterfactual benchmark

This is the deliverable that leaves the repo.

### Three policies, same fleet, same seed

| Policy | Description |
|---|---|
| `baseline` | Wallet per agent, static prefunding, no intent, no pooling. What people do today. |
| `treasury` | Entitlement pool, intent-driven buffer, tiered allocation. Your system. |
| `oracle` | Perfect foresight of every future spend. Theoretically optimal buffer. |

The oracle is the important addition. It means results are expressed as **"treasury captures X% of the theoretical maximum"** rather than "treasury beats baseline," which is a far more honest and far more defensible claim. It also tells you when to stop optimising.

### Metrics

```
capital_efficiency       yield-earning capital / total capital (mean, time-weighted)
idle_float               capital earning nothing (mean, peak)
reclaimed_capital        returned from expired entitlements
realised_yield           actual, vs oracle ceiling
settlement_latency       p50 / p95 / p99
buffer_breaches          count and total shortfall
rejections               by code
```

### The sensitivity sweep

Run `treasury` with intent accuracy varied from 0% to 100% in steps, holding everything else fixed. Plot capital efficiency against intent accuracy.

**That single curve is the most valuable output of this entire project.** It quantifies exactly what declared spend intent is worth, which is the one claim in the thesis that nobody else can make and nobody has measured. At 0% accuracy you should degrade gracefully toward baseline; the shape of the climb toward oracle is the argument.

### Output

```
bench/
  scenarios/*.json    Fleet configurations, committed to the repo
  run.ts              npm run bench
  results/            CSV + JSON, deterministic
```

Emit machine-readable results plus a plain-text summary table. No plotting library — write CSV and let the reader chart it.

Commit at least three scenarios: a high-frequency support fleet spending every few seconds, a long-horizon research fleet, and a mixed fleet. Real published benchmarks live or die on whether the scenarios are honest, so make the baseline genuinely well-tuned — a strawman baseline discredits the whole result.

---

## Also close

- The Phase 2 gap: run at least one adversarial test against a real ZeroDev Kernel account on Base Sepolia, gated behind credentials. `SessionKeyVault.sol` is a good harness but it is your own contract, and the security claim is currently unproven against production account abstraction.

---

## Out of scope

Real funds. Mainnet. Frontend. Multi-tenant. Auth. Persistence beyond a single process. Compute hedging.

---

## Definition of done

`npm run bench` produces a deterministic table showing capital efficiency for all three policies across three scenarios, plus the intent-accuracy sensitivity curve as CSV — and `npx` installs a working MCP server that a stranger can drive from Claude Desktop in five minutes.
