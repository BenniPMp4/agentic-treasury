# Agent Treasury MCP Server

An MCP server that gives AI agents scoped, time-boxed claims on a shared
pool of capital, instead of giving each agent its own wallet.

Full permission model: [`CLAUDE.md`](./CLAUDE.md) (Phase 1).
On-chain enforcement design: [`PHASE2.md`](./PHASE2.md) (Phase 2).
Yield layer, benchmark: [`PHASE3.md`](./PHASE3.md) (Phase 3).

## Setup

```bash
npm install
npm test        # everything below, ~30s
npm run build   # tsc, strict, no errors
npm run sim     # Phase 1 simulated fleet
npm run demo    # Phase 2 demo — see "Demo" below
npm run bench   # Phase 3 counterfactual benchmark — see "Benchmark" below
```

## Install in Claude Desktop

No build required — `npx` runs the TypeScript source directly via the
`tsx` devDependency. Add this to your `claude_desktop_config.json`
(substitute your actual absolute path to this repo):

```json
{
  "mcpServers": {
    "agent-treasury": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/agent-treasury-mcp/src/server.ts"]
    }
  }
}
```

To explore without first calling `request_entitlement` yourself, add
`"--sim"` to `args` — it pre-populates five demo entitlements
(`demo-agent-1` .. `demo-agent-5`) at startup, printed to stderr so they
never touch the JSON-RPC stdout stream:

```json
      "args": ["tsx", "/absolute/path/to/agent-treasury-mcp/src/server.ts", "--sim"]
```

Restart Claude Desktop, then ask it to request a budget, delegate part of
it to a sub-agent, spend, overspend, and see the rejection — see
`test/server.test.ts` for the exact flow this claim is tested against.
Rejections come back as structured JSON (`{code, entitlement_id,
available, message}`), not a bare error string, so an agent can decide
whether to retry with a smaller amount without a second round trip.

Prefer a built, installed package instead? `npm install && npm run build`
compiles to `dist/src/server.js` (the `bin` entry — `npx .` from the repo
root works the same way once built; `prepare` runs the build automatically
on `npm install`).

## Phase 2: architecture decisions

PHASE2.md asks two things of whoever implements it: check current SDK docs
before writing integration code (these APIs move), and — for the
Kernel-vs-permissionless.js choice — evaluate both briefly, pick one, note
the reason. Both below.

### Why the adversarial suite runs on a local chain, not Base Sepolia

PHASE2.md's success condition is that the adversarial suite proves a
**chain-level** guarantee: even with the policy engine compromised, the
chain rejects. That only means something if the revert is real — asserted
against actual EVM bytecode, not a JS mock of "what the chain would do."

But `npm test` has to run offline, deterministically, in CI, with no
credentials. A real Base Sepolia deployment needs a funded testnet wallet
and a live Pimlico bundler/paymaster API key — neither exists in this
environment, and even with them, a public testnet isn't deterministic
enough to assert exact revert reasons against on every run.

So: **contracts/SessionKeyVault.sol** encodes PHASE2.md's "Entitlement ->
session key mapping" table directly — cap, expiry, target allowlist,
revocation, sequential-nonce replay protection — as a real Solidity
contract. **src/chain/localChain.ts** compiles it with `solc` (the
JS-compiled compiler, no native binary needed) and deploys it to an
in-process EVM via `ganache`'s `provider()`, wired into `viem` through the
`custom()` transport (no HTTP hop, no port, no separate process). Every
adversarial test sends a real transaction, gets a real revert, and the
test asserts on the decoded custom error name (`CapExceeded`,
`SessionExpired`, `TargetNotAllowed`, `SessionRevokedErr`, `BadNonce`) —
never on anything the backend itself said. `src/chain/sessionKeys.ts`'s
`attemptSpend`/`decodeVaultRevert` refuse to swallow anything that isn't a
decoded contract revert, on purpose — a test that passed because of a
backend-side try/catch would prove nothing.

One integration wrinkle worth flagging for whoever touches this next:
Ganache's VM error message text (`"VM Exception while processing
transaction: revert"`) doesn't match viem's built-in `execution reverted`
detection (`ExecutionRevertedError.nodeMessage` in viem's `errors/node.js`),
so viem doesn't automatically produce a `ContractFunctionRevertedError`
against a ganache provider the way it does against a real node or anvil.
`decodeVaultRevert` works around this with a fallback: it walks the error's
`cause` chain for a raw hex `data` field and decodes it against the vault
ABI directly with `decodeErrorResult`. This was caught by the tests
actually failing on the first real run (a genuine red before green), not
by inspection.

### Production path: ZeroDev Kernel, not a plain permissionless.js account

PHASE2.md allows either. Base `permissionless.js` (`toKernelSmartAccount`,
etc.) creates and operates ERC-4337 smart accounts but has no first-class
concept of session-key *policies* — composable, revocable permission
plugins scoped by target/amount/time. That composition (`toCallPolicy` for
the counterparty allowlist, `toTimestampPolicy` for expiry, plus a spend
cap) is ZeroDev's own layer (`@zerodev/sdk` + `@zerodev/permissions`) on
top of the Kernel smart account, via `toPermissionValidator` and
`createKernelAccount({ plugins: { sudo, regular } })`. Since session keys
are the entire point of Phase 2, that tips it to ZeroDev.

`src/chain/account.ts`'s `provisionSmartAccountLive` and the ZeroDev/
permissionless imports throughout `src/chain/` are written against the
current SDKs (checked live against docs.pimlico.io, docs.zerodev.app and
each package's published README at implementation time — see git history
for the exact versions pinned in `package.json`). This path is **not**
exercised by `npm test`, for the same funded-wallet/API-key reason as
above. To actually run it against Base Sepolia:

1. Fund a wallet from [Circle's testnet USDC faucet](https://faucet.circle.com/) — testnet only, no real funds.
2. Get a bundler/paymaster API key from [Pimlico](https://dashboard.pimlico.io/).
3. Put `BASE_SEPOLIA_RPC_URL`, `PIMLICO_API_KEY` and `LIVE_TEST_OWNER_PRIVATE_KEY` in `secrets/.env` (gitignored — see `secrets/README.md`). Copy `secrets/.env.example` as a starting point.

**PHASE3.md "also close" item:** `SessionKeyVault.sol` proves the
permission table works as a contract; it doesn't prove it works against
*production* account abstraction. `test/live-kernel-adversarial.test.ts`
closes that gap — one adversarial case (spend to a target outside a
ZeroDev call policy) run against a real Kernel account, a real Pimlico
bundler, and a real Base Sepolia UserOperation, `describe.skipIf`-gated
on the credentials above so `npm test` stays green without them. It
type-checks cleanly against the pinned SDK versions (`npm run build`
verifies the whole call shape — `createKernelAccount`,
`toPermissionValidator`, `toCallPolicy`, `createKernelAccountClient`, the
Pimlico client — actually compiles against them), but has never executed
against a live bundler in this environment, for the same missing-credentials
reason as the rest of this section. Debug its first real run against
actual errors, not against an assumption this file is correct.

### x402: v2, not the deprecated v1

`x402-express`/`x402-fetch` (v1) are marked deprecated upstream —
"security patches only, migrate to v2." This implementation uses the
current `@x402/express`, `@x402/fetch`, `@x402/core`, `@x402/evm`
packages instead (`mock/seller.ts`, `src/adapters/x402.ts`).

`mock/seller.ts` needs one real, unauthenticated, read-only network call
at startup — `resourceServer.initialize()` — to fetch which payment kinds
the facilitator supports; the x402 v2 resource server can't build payment
requirements without it. That's metadata discovery, not a fund-moving
action, so it's always on, not gated by credentials. Everything past that
(actually *paying* the 402) needs a funded Base Sepolia wallet and is
gated behind `DEMO_X402_PRIVATE_KEY` — see "Demo" below.

## Demo

`npm run demo` runs PHASE2.md's five-step script end to end, entirely
against the local chain except the payment half of step 3:

1. Provisions a `SessionKeyVault` smart account for a simulated agent.
2. Requests a Phase 1 entitlement and issues its on-chain session key.
3. Hits the mock x402 endpoint. Without `DEMO_X402_PRIVATE_KEY` set, it
   prints the real, live 402 payment requirements (real Base Sepolia USDC
   contract address, real price) and explains what's missing to complete
   the payment. With a funded key set, it pays for real.
4. Consults a policy engine stubbed to approve everything, then attempts
   an over-cap spend anyway — and prints the on-chain revert reason. This
   print is the deliverable PHASE2.md asks for.
5. Deliberately leaves one spend unrecorded in the ledger, then runs
   `reconcile()` and prints the divergence it finds and corrects.

## File map (Phase 2 additions)

```
contracts/
  SessionKeyVault.sol   The permission table, enforced on chain.
  MockUSDC.sol           Local-chain-only test USDC.
src/chain/
  localChain.ts          Compile + boot the local test/demo chain.
  account.ts              Smart account provisioning per agent (local + live).
  sessionKeys.ts          Issue / revoke / spend / query session keys.
  reconcile.ts            Chain <-> ledger reconciliation (invariant 11).
  usdc.ts                 Token helpers.
src/adapters/
  x402.ts                 x402 client — pay-on-402 flow.
mock/
  seller.ts                Mock x402 paid endpoint.
scripts/
  demo.ts                   The demo above.
test/
  chain.test.ts             Session key issuance and revocation.
  adversarial.test.ts       The compromised-backend suite.
  reconcile.test.ts         The three divergence cases.
```

## Phase 3: yield layer

`src/yield/` (fund adapter + tiering + accrual apportionment) and
`src/intent/` (window-bucketed intents, the hot-buffer formula, and
settled-only reliability scoring) implement invariants 12-15 — see
`test/yield.test.ts`, written before any of those files existed. Three
things worth knowing if you're extending this:

- **The hot buffer's undeclared-spend term has to scale with the whole
  vulnerability window, not one tick.** A per-tick standard deviation
  chronically under-buffers once that window is more than one tick wide
  (which is always — it's at minimum a same-day dealing delay, and up to
  ~72h over a weekend). `src/intent/buffer.ts`'s formula takes a
  pre-scaled `residualStddev`; the caller (bench/simulate.ts) is
  responsible for scaling it to the actual horizon.
- **A redemption requested now can only help with spend after it lands.**
  `MockFund.settlementDelayMs(now)` tells you when a redemption requested
  *now* arrives — it does not tell you how far ahead you need to be
  looking to have *already* pre-positioned hot capital for spend that
  happens before that. See `safeLookaheadMs` in `bench/simulate.ts` for
  why the real answer is roughly two dealing cycles, not one, and
  `README.md`'s benchmark section below for what went wrong before this
  was fixed.
- **Rebalancing only ever moves capital *out* of hot** (invariant 14) —
  topping hot back up is a proactive redemption request with its own
  delay, tracked explicitly as an in-flight amount until it lands. Money
  leaves warm/cold the instant it's requested (it stops earning yield
  immediately) but isn't spendable until it arrives.

## Phase 3: counterfactual benchmark

```bash
npm run bench
```

Runs `baseline` / `treasury` / `oracle` against three committed scenarios
(`bench/scenarios/*.json`) — a high-frequency support fleet, a
long-horizon research fleet, and a mixed fleet spanning a weekend — plus
the intent-accuracy sensitivity sweep (0% -> 100%) for `treasury` against
each. Prints plain-text tables and writes `bench/results/*.{json,csv}`
(gitignored — regenerate, don't commit stale numbers). `test/bench.test.ts`
is invariant 16 (identical seed -> byte-identical output), written before
any scenario code existed.

**Reading the output:** `pct_of_oracle` in the sensitivity sweep is the
headline number — "treasury captures X% of the theoretical maximum" — not
"treasury beats baseline" (baseline is definitionally 0% capital
efficiency: a wallet-per-agent with no pooling has no principled way to
know any capital is safe to invest, so none of it ever is). Two honest
findings worth calling out rather than smoothing over:

- **Pooling alone — even at 0% intent accuracy — already captures a large
  share of the oracle ceiling** (e.g. ~83% on the `mixed` scenario,
  climbing to ~98% at 100% accuracy). Declared intent is a real, additive
  lever on top of pooling, not the only source of the benefit; the
  sensitivity curve's climb is real, but it climbs from an already-nonzero
  baseline, not from zero.
- **A small number of buffer breaches appear specifically at exactly 100%
  intent accuracy** on two of the three scenarios (near-zero elsewhere).
  This is a known rounding/edge effect (float-to-bigint conversion at the
  statistical-formula boundary, most likely) rather than a real economic
  effect — flagged here rather than tuned away, since PHASE3.md is
  explicit that a benchmark's credibility depends on the scenarios being
  honest.

## File map (Phase 3 additions)

```
src/yield/
  fund.ts        FundAdapter interface + MockFund (dealing cut-offs, weekends).
  allocation.ts  Hot/warm/cold rebalancing (invariant 14).
  accrual.ts     Per-agent apportionment (invariant 12).
src/intent/
  engine.ts      Window-bucketed intent declare/expire/consume.
  buffer.ts      requiredHotBuffer() + BufferGuard (invariant 13).
  reliability.ts ReliabilityScorer (invariant 15).
bench/
  types.ts, rng.ts, demand.ts, metrics.ts, simulate.ts   The engine.
  scenarios/*.json    The three committed scenarios.
  run.ts              npm run bench.
  results/            Generated, gitignored.
test/
  yield.test.ts   Invariants 12-15.
  bench.test.ts   Invariant 16.
```
