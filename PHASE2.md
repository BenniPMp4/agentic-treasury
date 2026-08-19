# PHASE2.md — On-Chain Entitlement Enforcement

Read alongside CLAUDE.md. The permission model and invariants there still apply in full and are unchanged. This document adds the on-chain layer.

---

## Objective

Make entitlements enforceable by the chain, not the backend.

**Success condition:** with the policy engine deliberately compromised to approve everything, an agent still cannot spend beyond its entitlement, past its expiry, or to a disallowed counterparty.

---

## The new invariant

**11. The chain is authoritative for what was spent. The ledger is authoritative for what was intended and how it is attributed.**

Where they disagree, the chain wins and the ledger is corrected. The ledger is never used to override an on-chain outcome.

This is the core design decision of Phase 2. Everything below follows from it.

---

## Entitlement → session key mapping

| Entitlement field | Session key permission |
|---|---|
| `amount_granted` | Cumulative spend cap on the USDC transfer target |
| `expires_at` | `validUntil` |
| `counterparty_allow` | Target address allowlist |
| `status: revoked` | On-chain key invalidation |
| `parent_id` | Enforced off-chain at issuance — the parent's own cap already bounds the child, since children draw from the same smart account |

Delegation stays off-chain. Only leaf entitlements that actually spend need a session key. Do not attempt to represent the delegation tree on chain.

---

## Stack

- **Chain:** Base Sepolia
- **Asset:** testnet USDC (Circle faucet)
- **Chain client:** `viem`
- **Account abstraction:** ERC-4337 via `permissionless.js` with a Pimlico bundler and paymaster. ZeroDev's Kernel is an acceptable alternative if session key support proves easier there — evaluate both briefly, pick one, note the reason in the README.
- **Payments:** `x402` (Coinbase / Linux Foundation) — use its seller middleware for the mock paid endpoint

**Check current SDK docs before writing integration code.** These APIs move; do not rely on remembered signatures.

---

## New files

```
src/chain/
  account.ts       Smart account provisioning per agent
  sessionKeys.ts   Issue, revoke, and query session keys from entitlements
  reconcile.ts     Chain ↔ ledger reconciliation loop
  usdc.ts          Token helpers
src/adapters/
  x402.ts          x402 client — pay-on-402 flow
test/
  chain.test.ts        Session key issuance and revocation
  adversarial.test.ts  The compromised-backend suite
  reconcile.test.ts    Divergence handling
mock/
  seller.ts        Mock x402 paid endpoint
```

Keep the existing Phase 1 files unchanged in behaviour. The chain layer sits behind the same `Ledger` interface boundary — `settlement.ts` should not know whether it is settling on chain or in memory.

---

## Reconciliation

Run a loop that:

1. Reads on-chain spend per session key
2. Compares against ledger `amount_spent` for that entitlement
3. On divergence, writes a correcting ledger entry and emits a `RECONCILIATION_DIVERGENCE` event with both values

Handle these three cases explicitly, with a test each:

- **Chain ahead of ledger** — settlement landed, ledger write failed. Correct the ledger.
- **Ledger ahead of chain** — ledger written, transaction reverted or never mined. Release the reservation.
- **Chain spend with no ledger record** — a settlement bypassed the MCP server. Record it as unattributed and flag it.

The third case is the interesting one. It will happen, and it is the reason the chain is authoritative.

---

## Adversarial test suite

This is the deliverable that matters. Each test stubs the policy engine to return unconditional approval, then asserts the chain rejects:

1. Spend exceeding `amount_granted`
2. Spend after `expires_at`
3. Spend to an address outside `counterparty_allow`
4. Spend on a revoked entitlement
5. Cumulative spend across multiple transactions exceeding the cap
6. Replay of a previously valid signed operation

Assert on the revert, not on a backend rejection. A test that passes because the backend said no is a failed test — it proves nothing about the security property.

---

## Out of scope

No mainnet. No real funds. No fund adapter or NAV (that is Phase 3). No gas optimisation. No frontend. No multi-chain.

---

## Definition of done

`npm test` green, including all six adversarial tests, and a script that:

1. Provisions a smart account for a simulated agent
2. Issues an entitlement and its session key
3. Pays a mock x402 endpoint successfully
4. Attempts an over-cap spend with the policy engine compromised, and shows the on-chain revert
5. Prints the reconciliation report

Step 4 printing a revert reason is the demo.
