// Execute spend. Enforces invariants 4 and 8.
import type { Ledger } from "./ledger.js";
import { TreasuryError } from "./ledger.js";
import type { EntitlementStore } from "./entitlements.js";
import type { IntentStore } from "./intents.js";

export interface Settlement {
  id: string;
  entitlement_id: string;
  agent_id: string;
  amount: bigint;
  counterparty: string;
  task_id: string;
  intent_id: string | null;
  timestamp: number;
}

export interface SettleParams {
  entitlement_id: string;
  amount: bigint;
  counterparty: string;
  task_id: string;
  intent_id?: string;
}

export interface TaskCost {
  total: bigint;
  by_agent: { agent_id: string; amount: bigint }[];
  settlement_count: number;
}

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `stl_${idCounter}`;
}

export class SettlementService {
  private settlements: Settlement[] = [];

  constructor(
    private ledger: Ledger,
    private entitlements: EntitlementStore,
    private intents: IntentStore
  ) {}

  settle(params: SettleParams, now: number = Date.now()): { settlement_id: string; status: "settled" } {
    const ent = this.entitlements.get(params.entitlement_id, now);

    // Invariant 4: active, unexpired, sufficient remainder.
    if (ent.status === "expired") throw new TreasuryError("ENTITLEMENT_EXPIRED");
    if (ent.status === "revoked") throw new TreasuryError("ENTITLEMENT_REVOKED");

    if (
      ent.counterparty_allow.length > 0 &&
      !ent.counterparty_allow.includes(params.counterparty)
    ) {
      throw new TreasuryError("COUNTERPARTY_NOT_ALLOWED");
    }

    // recordSpend re-checks the remainder and enforces invariant 1/4 atomically.
    this.entitlements.recordSpend(ent.id, params.amount, now);

    if (params.intent_id) {
      this.intents.consume(params.intent_id);
    }

    const settlement: Settlement = {
      id: nextId(),
      entitlement_id: ent.id,
      agent_id: ent.agent_id,
      amount: params.amount,
      counterparty: params.counterparty,
      task_id: params.task_id,
      intent_id: params.intent_id ?? null,
      timestamp: now,
    };

    // Invariant 8: double-entry, debit agent, credit counterparty.
    this.ledger.postSettlement(
      settlement.id,
      settlement.agent_id,
      settlement.counterparty,
      settlement.amount,
      now
    );

    this.settlements.push(settlement);

    return { settlement_id: settlement.id, status: "settled" };
  }

  getTaskCost(taskId: string): TaskCost {
    const rows = this.settlements.filter((s) => s.task_id === taskId);
    const byAgent = new Map<string, bigint>();
    let total = 0n;
    for (const row of rows) {
      total += row.amount;
      byAgent.set(row.agent_id, (byAgent.get(row.agent_id) ?? 0n) + row.amount);
    }
    return {
      total,
      by_agent: [...byAgent.entries()].map(([agent_id, amount]) => ({ agent_id, amount })),
      settlement_count: rows.length,
    };
  }
}
