# CLAUDE.md — Agent Treasury MCP Server

Drop this at repo root. It contains the **complete** permission model. Do not read other files to understand permissions — they are fully specified here.

---

## What this is

An MCP server that gives AI agents scoped, time-boxed claims on a shared pool of capital, instead of giving each agent its own wallet.

**Core idea:** entitlements, not wallets. An entitlement is a ledger authorisation, not a transfer. Capital stays pooled and earning; agents draw against it just in time.

Phase 1 scope: in-memory ledger, simulated agents, no blockchain, no real funds.

---

## THE PERMISSION MODEL (complete — never look elsewhere)

### Objects

```
Pool          One per tenant. Holds all capital. Has: total, reserved, available.
Entitlement   A scoped claim against the Pool.
Intent        A declaration of imminent spend against an Entitlement.
Settlement    An executed spend that consumes an Entitlement.
Task          An identifier propagated through the agent call graph for attribution.
```

### Entitlement fields

```
id                  string
agent_id            string
parent_id           string | null    null = root, granted from Pool
amount_granted      bigint           minor units
amount_spent        bigint
amount_delegated    bigint           sum granted to children
currency            "USDC"
expires_at          timestamp
counterparty_allow  string[]         empty = allow all
status              "active" | "expired" | "revoked"
```

### Invariants — enforce all of these, always

1. `amount_spent + amount_delegated <= amount_granted` — an entitlement can never over-commit.
2. A child entitlement's `amount_granted` can never exceed the parent's unallocated remainder.
3. A child's `expires_at` can never exceed its parent's `expires_at`.
4. No settlement without an `active`, unexpired entitlement with sufficient remainder.
5. On expiry or revocation, unspent amount returns to the parent (or Pool) **atomically** in the same transaction.
6. Revoking an entitlement revokes its entire subtree, depth-first, in one transaction.
7. A child's `counterparty_allow` must be a subset of its parent's (empty parent set = no restriction inherited).
8. Every settlement is double-entry: debit agent account, credit counterparty account. The ledger must always balance.
9. Intents reserve against the Pool's hot buffer but never reduce `amount_granted`. An expired intent releases its reservation.
10. Delegation depth is capped at 5. Reject deeper.

### Rejection codes

Return these exact strings — tests depend on them.

```
ENTITLEMENT_EXPIRED
ENTITLEMENT_REVOKED
INSUFFICIENT_ENTITLEMENT
PARENT_INSUFFICIENT
EXPIRY_EXCEEDS_PARENT
COUNTERPARTY_NOT_ALLOWED
DELEGATION_TOO_DEEP
POOL_INSUFFICIENT
```

---

## MCP tools to expose

| Tool | Args | Returns |
|---|---|---|
| `request_entitlement` | `agent_id, amount, ttl_seconds, parent_id?, counterparty_allow?` | `entitlement_id, amount_granted, expires_at` |
| `declare_intent` | `entitlement_id, amount, class, earliest?, latest?, counterparty_class?` | `intent_id, reserved` |
| `check_balance` | `entitlement_id` | `granted, spent, delegated, available, expires_at` |
| `settle` | `entitlement_id, amount, counterparty, task_id, intent_id?` | `settlement_id, status` |
| `revoke_entitlement` | `entitlement_id` | `revoked_count, returned_amount` |
| `get_shadow_rate` | — | `rate_bps, pool_utilisation, defer_saving_bps` |
| `get_task_cost` | `task_id` | `total, by_agent[], settlement_count` |

`class` is one of `COMMITTED | PROBABLE | SPECULATIVE`.

### Resources

```
treasury://pool/status
treasury://agent/{agent_id}/entitlements
treasury://task/{task_id}/costs
```

---

## Stack

- **TypeScript**, Node 20+
- `@modelcontextprotocol/sdk` — MCP server
- `vitest` — tests
- `zod` — tool arg validation
- In-memory ledger behind a `Ledger` interface (TigerBeetle swaps in later — do not add it now)

---

## File map

```
src/
  server.ts        MCP server, tool registration only
  ledger.ts        Ledger interface + in-memory impl. Double-entry.
  entitlements.ts  Issue, delegate, revoke, expire. Enforces invariants 1-7, 10.
  intents.ts       Declare, reserve, expire. Invariant 9.
  settlement.ts    Execute spend. Invariants 4, 8.
  shadow.ts        Shadow rate calc.
  sim/fleet.ts     Simulated agent fleet for testing.
test/
  invariants.test.ts   One test per invariant. These are the spec.
```

Flat structure. Do not create subdirectories beyond this.

---

## Conventions

- All amounts are `bigint` in minor units. Never use floats for money.
- All times are UTC ISO-8601 strings at API boundaries, epoch millis internally.
- Every state mutation goes through the ledger. Nothing mutates entitlement balances directly.
- Errors are thrown with the exact rejection codes above as the message.
- No `any`. Strict TypeScript.

---

## Working instructions

- **The permission model above is complete.** Do not re-read `entitlements.ts` or any other file to recall the rules — they are in this document.
- **Verify by running `npm test`, not by re-reading source.** The invariant tests are the source of truth for behaviour.
- Write the test before the implementation for anything touching invariants.
- Do not add features not listed here. No auth, no persistence, no chain, no HTTP server, no logging framework.
- Keep `server.ts` thin — it registers tools and delegates. No business logic.

---

## Definition of done for Phase 1

`npm test` passes with one test per invariant, and the simulated fleet can run 1,000 agents drawing on one pool for 24 simulated hours, producing:

- total capital reclaimed from expired entitlements
- peak vs mean pool utilisation
- count of rejected settlements by rejection code

That output is the demo.
