#!/usr/bin/env node
// MCP server: tool + resource registration only. No business logic here —
// everything delegates to ledger.ts / entitlements.ts / intents.ts /
// settlement.ts / shadow.ts.
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { InMemoryLedger, TreasuryError } from "./ledger.js";
import { EntitlementStore } from "./entitlements.js";
import { IntentStore } from "./intents.js";
import { SettlementService } from "./settlement.js";
import { getShadowRate } from "./shadow.js";
import { seedDemoEntitlements } from "./sim/fleet.js";

const TENANT = "default";
const POOL_SEED = 100_000_000n; // demo seed capital, minor units (USDC, 6dp)

// `--sim` (or AGENT_TREASURY_SIM=1) pre-populates a few demo entitlements
// at startup so a stranger driving this from Claude Desktop has something
// to call check_balance/settle against immediately, with no chain, no
// credentials, and no prior request_entitlement call of their own.
const SIM_MODE = process.argv.includes("--sim") || process.env.AGENT_TREASURY_SIM === "1";

const ledger = new InMemoryLedger();
ledger.createPool(TENANT, POOL_SEED);
const entitlements = new EntitlementStore(ledger);
const intents = new IntentStore(ledger, entitlements);
const settlementSvc = new SettlementService(ledger, entitlements, intents);

if (SIM_MODE) {
  const seeded = seedDemoEntitlements(entitlements, { tenantId: TENANT });
  // stderr only — stdout is the JSON-RPC stream for the stdio transport.
  console.error("[agent-treasury] sim mode: seeded demo entitlements");
  for (const s of seeded) {
    console.error(`  ${s.agent_id}: ${s.entitlement_id} (granted ${s.amount_granted} minor units)`);
  }
}

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

/**
 * Structured MCP error: `code` is the exact RejectionCode string (or null
 * for a non-TreasuryError), plus enough context to retry without another
 * round trip — which entitlement was involved and what's actually
 * available against it right now.
 */
function toError(err: unknown, context?: { entitlement_id?: string | null; available?: bigint | null }) {
  const code = err instanceof TreasuryError ? err.code : null;
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          code,
          entitlement_id: context?.entitlement_id ?? null,
          available: context?.available != null ? context.available.toString() : null,
          message,
        }),
      },
    ],
    isError: true as const,
  };
}

/** Best-effort balance lookup for error context — the entitlement itself
 * may be the thing that's unknown/invalid, in which case we just omit it. */
function availableFor(entitlementId: string): bigint | null {
  try {
    return entitlements.checkBalance(entitlementId).available;
  } catch {
    return null;
  }
}

function poolAvailable(): bigint {
  const pool = ledger.getPool(TENANT);
  return pool.total - pool.reserved - pool.granted;
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
      // No entitlement exists yet — context is the parent's remainder
      // (for delegation errors) or the pool's remainder (for a root
      // request), whichever the rejection actually bears on.
      const available = args.parent_id ? availableFor(args.parent_id) : poolAvailable();
      return toError(err, { entitlement_id: args.parent_id ?? null, available });
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
      return toError(err, { entitlement_id: args.entitlement_id, available: availableFor(args.entitlement_id) });
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
      return toError(err, { entitlement_id: args.entitlement_id });
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
      return toError(err, { entitlement_id: args.entitlement_id, available: availableFor(args.entitlement_id) });
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
      return toError(err, { entitlement_id: args.entitlement_id });
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
