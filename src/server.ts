#!/usr/bin/env node
// MCP server: tool + resource registration only. No business logic here —
// everything delegates to ledger.ts / entitlements.ts / intents.ts /
// settlement.ts / shadow.ts.
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { InMemoryLedger } from "./ledger.js";
import { EntitlementStore } from "./entitlements.js";
import { IntentStore } from "./intents.js";
import { SettlementService } from "./settlement.js";
import { getShadowRate } from "./shadow.js";

const TENANT = "default";
const POOL_SEED = 100_000_000n; // demo seed capital, minor units (USDC, 6dp)

const ledger = new InMemoryLedger();
ledger.createPool(TENANT, POOL_SEED);
const entitlements = new EntitlementStore(ledger);
const intents = new IntentStore(ledger, entitlements);
const settlementSvc = new SettlementService(ledger, entitlements, intents);

const server = new McpServer({ name: "agent-treasury", version: "0.1.0" });

// ---- JSON boundary helpers ---------------------------------------------
// Amounts cross the wire as decimal-integer strings (JSON has no bigint).

const amountString = z
  .string()
  .regex(/^\d+$/, "amount must be a non-negative integer string in minor units")
  .transform((s) => BigInt(s));

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function toJson(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2),
      },
    ],
  };
}

function toError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

// ---- Tools ----------------------------------------------------------------

server.registerTool(
  "request_entitlement",
  {
    description: "Request a scoped, time-boxed entitlement against the pool, or delegate from a parent entitlement.",
    inputSchema: {
      agent_id: z.string(),
      amount: amountString,
      ttl_seconds: z.number().int().positive(),
      parent_id: z.string().optional(),
      counterparty_allow: z.array(z.string()).optional(),
    },
  },
  async (args) => {
    try {
      const ent = entitlements.request({
        tenantId: TENANT,
        agent_id: args.agent_id,
        amount: args.amount,
        ttl_seconds: args.ttl_seconds,
        parent_id: args.parent_id ?? null,
        counterparty_allow: args.counterparty_allow,
      });
      return toJson({
        entitlement_id: ent.id,
        amount_granted: ent.amount_granted,
        expires_at: iso(ent.expires_at),
      });
    } catch (err) {
      return toError(err);
    }
  }
);

server.registerTool(
  "declare_intent",
  {
    description: "Declare imminent spend against an entitlement, reserving against the pool's hot buffer.",
    inputSchema: {
      entitlement_id: z.string(),
      amount: amountString,
      class: z.enum(["COMMITTED", "PROBABLE", "SPECULATIVE"]),
      earliest: z.string().datetime().optional(),
      latest: z.string().datetime().optional(),
      counterparty_class: z.string().optional(),
    },
  },
  async (args) => {
    try {
      const result = intents.declare({
        entitlement_id: args.entitlement_id,
        amount: args.amount,
        class: args.class,
        earliest: args.earliest ? Date.parse(args.earliest) : undefined,
        latest: args.latest ? Date.parse(args.latest) : undefined,
        counterparty_class: args.counterparty_class,
      });
      return toJson(result);
    } catch (err) {
      return toError(err);
    }
  }
);

server.registerTool(
  "check_balance",
  {
    description: "Check an entitlement's granted, spent, delegated and available balance.",
    inputSchema: { entitlement_id: z.string() },
  },
  async (args) => {
    try {
      const bal = entitlements.checkBalance(args.entitlement_id);
      return toJson({ ...bal, expires_at: iso(bal.expires_at) });
    } catch (err) {
      return toError(err);
    }
  }
);

server.registerTool(
  "settle",
  {
    description: "Execute a spend against an entitlement, consuming it via a balanced double-entry posting.",
    inputSchema: {
      entitlement_id: z.string(),
      amount: amountString,
      counterparty: z.string(),
      task_id: z.string(),
      intent_id: z.string().optional(),
    },
  },
  async (args) => {
    try {
      const result = settlementSvc.settle({
        entitlement_id: args.entitlement_id,
        amount: args.amount,
        counterparty: args.counterparty,
        task_id: args.task_id,
        intent_id: args.intent_id,
      });
      return toJson(result);
    } catch (err) {
      return toError(err);
    }
  }
);

server.registerTool(
  "revoke_entitlement",
  {
    description: "Revoke an entitlement and its entire subtree, returning unspent capital atomically.",
    inputSchema: { entitlement_id: z.string() },
  },
  async (args) => {
    try {
      const result = entitlements.revoke(args.entitlement_id);
      return toJson(result);
    } catch (err) {
      return toError(err);
    }
  }
);

server.registerTool(
  "get_shadow_rate",
  { description: "Get the current shadow rate and pool utilisation." },
  async () => {
    try {
      return toJson(getShadowRate(ledger, TENANT));
    } catch (err) {
      return toError(err);
    }
  }
);

server.registerTool(
  "get_task_cost",
  {
    description: "Get total spend, per-agent breakdown, and settlement count for a task.",
    inputSchema: { task_id: z.string() },
  },
  async (args) => {
    try {
      return toJson(settlementSvc.getTaskCost(args.task_id));
    } catch (err) {
      return toError(err);
    }
  }
);

// ---- Resources --------------------------------------------------------

server.registerResource(
  "pool-status",
  "treasury://pool/status",
  { description: "Current pool capital, reservations, and utilisation." },
  async (uri) => {
    const pool = ledger.getPool(TENANT);
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(
            {
              total: pool.total.toString(),
              reserved: pool.reserved.toString(),
              granted: pool.granted.toString(),
              available: (pool.total - pool.reserved - pool.granted).toString(),
              utilisation: ledger.poolUtilisation(TENANT),
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.registerResource(
  "agent-entitlements",
  new ResourceTemplate("treasury://agent/{agent_id}/entitlements", { list: undefined }),
  { description: "All entitlements held by an agent." },
  async (uri, params) => {
    const raw = params.agent_id;
    const agentId = Array.isArray(raw) ? raw[0] : raw;
    if (!agentId) throw new Error("agent_id is required");
    const list = entitlements.listByAgent(agentId);
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(
            list.map((e) => ({
              ...e,
              amount_granted: e.amount_granted.toString(),
              amount_spent: e.amount_spent.toString(),
              amount_delegated: e.amount_delegated.toString(),
              expires_at: iso(e.expires_at),
            })),
            null,
            2
          ),
        },
      ],
    };
  }
);

server.registerResource(
  "task-costs",
  new ResourceTemplate("treasury://task/{task_id}/costs", { list: undefined }),
  { description: "Total spend and breakdown for a task." },
  async (uri, params) => {
    const rawTaskId = params.task_id;
    const taskId = Array.isArray(rawTaskId) ? rawTaskId[0] : rawTaskId;
    if (!taskId) throw new Error("task_id is required");
    const cost = settlementSvc.getTaskCost(taskId);
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(
            {
              total: cost.total.toString(),
              settlement_count: cost.settlement_count,
              by_agent: cost.by_agent.map((a) => ({ agent_id: a.agent_id, amount: a.amount.toString() })),
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("agent-treasury MCP server failed to start:", err);
  process.exit(1);
});
