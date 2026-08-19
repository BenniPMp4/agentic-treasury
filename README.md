# Agent Treasury MCP Server

An MCP server that gives AI agents scoped, time-boxed claims on a shared
pool of capital, instead of giving each agent its own wallet.

Full permission model: [`CLAUDE.md`](./CLAUDE.md) (Phase 1).
On-chain enforcement design: [`PHASE2.md`](./PHASE2.md) (Phase 2).

## Setup

```bash
npm install
npm test        # everything below, ~30s
npm run build   # tsc, strict, no errors
npm run sim     # Phase 1 simulated fleet
npm run demo    # Phase 2 demo — see "Demo" below
```

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
3. Put `BASE_SEPOLIA_RPC_URL` and `PIMLICO_API_KEY` in `secrets/.env` (gitignored — see `secrets/README.md`). Copy `secrets/.env.example` as a starting point.

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
