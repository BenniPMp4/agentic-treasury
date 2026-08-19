// Chain <-> ledger reconciliation loop. Invariant 11: the chain is
// authoritative for what was spent; the ledger is authoritative for what
// was intended and how it's attributed. Where they disagree, the chain
// wins and the ledger is corrected — never the other way around.
//
// Three cases, each with its own test in test/reconcile.test.ts:
//   - chain ahead of ledger  — a settlement landed on chain but the
//     ledger write that should have accompanied it never happened (crash,
//     dropped write, whatever). We pull the ledger up to match.
//   - ledger ahead of chain  — the ledger recorded a spend but the
//     transaction reverted or was never mined. We pull the ledger back
//     down, releasing the difference.
//   - chain spend with no ledger record at all — a settlement happened
//     through a session key this registry has never heard of, meaning it
//     bypassed the MCP server entirely. There is no entitlement to
//     correct. We record it as unattributed and flag it rather than
//     drop it — this is the case that justifies invariant 11 existing.
import type { Abi, Address, PublicClient } from "viem";
import type { EntitlementStore } from "../entitlements.js";
import type { SessionKeyRegistry } from "./sessionKeys.js";

export type DivergenceDirection = "chain_ahead" | "ledger_ahead" | "unattributed";

export interface DivergenceEvent {
  type: "RECONCILIATION_DIVERGENCE";
  direction: DivergenceDirection;
  entitlement_id: string | null;
  session_key: Address;
  vault: Address;
  chain_spent: bigint;
  ledger_spent: bigint | null;
  timestamp: number;
}

export interface ReconcileParams {
  publicClient: PublicClient;
  vaultAbi: Abi;
  /** Every vault address in play — reconcile scans each for `Spent` events. */
  vaults: Address[];
  registry: SessionKeyRegistry;
  entitlements: EntitlementStore;
  now?: number;
}

export interface ReconcileReport {
  events: DivergenceEvent[];
  corrected: number;
  unattributed: number;
}

interface ChainSpendEntry {
  vault: Address;
  sessionKey: Address;
  amount: bigint;
}

async function sumSpentByVaultAndSessionKey(
  publicClient: PublicClient,
  vaultAbi: Abi,
  vaults: Address[]
): Promise<Map<string, ChainSpendEntry>> {
  const totals = new Map<string, ChainSpendEntry>();
  for (const vault of vaults) {
    const logs = await publicClient.getContractEvents({
      address: vault,
      abi: vaultAbi,
      eventName: "Spent",
      fromBlock: 0n,
      toBlock: "latest",
    });
    for (const log of logs) {
      const args = log.args as { sessionKey?: Address; amount?: bigint };
      if (!args.sessionKey || args.amount === undefined) continue;
      const key = `${vault.toLowerCase()}:${args.sessionKey.toLowerCase()}`;
      const existing = totals.get(key);
      totals.set(key, {
        vault,
        sessionKey: args.sessionKey,
        amount: (existing?.amount ?? 0n) + args.amount,
      });
    }
  }
  return totals;
}

export async function reconcile(params: ReconcileParams): Promise<ReconcileReport> {
  const now = params.now ?? Date.now();
  const chainSpent = await sumSpentByVaultAndSessionKey(params.publicClient, params.vaultAbi, params.vaults);

  const events: DivergenceEvent[] = [];
  let corrected = 0;
  let unattributed = 0;
  const seenKeys = new Set<string>();

  // Every session key the backend knows about, including ones with zero
  // on-chain events yet (catches "ledger ahead" when the transaction never
  // made it to the chain at all).
  for (const record of params.registry.all()) {
    const key = `${record.vault.toLowerCase()}:${record.session_key.toLowerCase()}`;
    seenKeys.add(key);

    const onChain = chainSpent.get(key)?.amount ?? 0n;
    const ledgerSpent = params.entitlements.checkBalance(record.entitlement_id, now).spent;
    if (onChain === ledgerSpent) continue;

    params.entitlements.correctSpent(record.entitlement_id, onChain, now);
    corrected += 1;
    events.push({
      type: "RECONCILIATION_DIVERGENCE",
      direction: onChain > ledgerSpent ? "chain_ahead" : "ledger_ahead",
      entitlement_id: record.entitlement_id,
      session_key: record.session_key,
      vault: record.vault,
      chain_spent: onChain,
      ledger_spent: ledgerSpent,
      timestamp: now,
    });
  }

  // Chain activity from session keys the registry has never heard of —
  // a settlement that bypassed the MCP server entirely.
  for (const [key, entry] of chainSpent) {
    if (seenKeys.has(key)) continue;
    unattributed += 1;
    events.push({
      type: "RECONCILIATION_DIVERGENCE",
      direction: "unattributed",
      entitlement_id: null,
      session_key: entry.sessionKey,
      vault: entry.vault,
      chain_spent: entry.amount,
      ledger_spent: null,
      timestamp: now,
    });
  }

  return { events, corrected, unattributed };
}
