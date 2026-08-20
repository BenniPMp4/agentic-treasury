// End-to-end proof of PHASE3.md's "A" definition of done: a stranger can
// install this and have an agent request a budget, delegate, overspend,
// and get rejected — in under five minutes. This drives the actual
// shipped server over real stdio via `npx tsx src/server.ts`, exactly the
// way Claude Desktop or any other MCP client would.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

interface ToolTextResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

function parseJson(result: ToolTextResult): any {
  const text = result.content[0]?.text;
  if (typeof text !== "string") throw new Error("tool result had no text content");
  return JSON.parse(text);
}

/** Resource reads can return text or blob contents; every resource in
 * this server is JSON text, so narrow to that or fail loudly. */
function resourceText(contents: unknown[]): string {
  const text = (contents[0] as { text?: unknown } | undefined)?.text;
  if (typeof text !== "string") throw new Error("resource result had no text content");
  return text;
}

describe("shipped MCP server: request a budget, delegate, overspend, get rejected", () => {
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    transport = new StdioClientTransport({
      command: "npx",
      args: ["tsx", "src/server.ts"],
      cwd: process.cwd(),
    });
    client = new Client({ name: "test-client", version: "0.0.1" });
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    await client.close();
  });

  it("lists all 7 tools and 3 resource templates", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "check_balance",
        "declare_intent",
        "get_shadow_rate",
        "get_task_cost",
        "request_entitlement",
        "revoke_entitlement",
        "settle",
      ].sort()
    );

    const resources = await client.listResourceTemplates();
    const uris = resources.resourceTemplates.map((r) => r.uriTemplate).sort();
    expect(uris).toEqual(
      ["treasury://agent/{agent_id}/entitlements", "treasury://task/{task_id}/costs"].sort()
    );

    const staticResources = await client.listResources();
    expect(staticResources.resources.map((r) => r.uri)).toContain("treasury://pool/status");
  });

  it("requests a budget, delegates, spends, overspends and gets a structured rejection", async () => {
    // 1. Request a budget (root entitlement).
    const rootResult = await client.callTool({
      name: "request_entitlement",
      arguments: { agent_id: "manager", amount: "10000", ttl_seconds: 3600 },
    });
    const root = parseJson(rootResult as ToolTextResult);
    expect(root.entitlement_id).toMatch(/^ent_/);
    expect(root.amount_granted).toBe("10000");

    // 2. Delegate to a sub-agent.
    const childResult = await client.callTool({
      name: "request_entitlement",
      arguments: {
        agent_id: "worker",
        amount: "4000",
        ttl_seconds: 1800,
        parent_id: root.entitlement_id,
      },
    });
    const child = parseJson(childResult as ToolTextResult);
    expect(child.amount_granted).toBe("4000");

    // 3. Spend within budget.
    const settleResult = await client.callTool({
      name: "settle",
      arguments: {
        entitlement_id: child.entitlement_id,
        amount: "1500",
        counterparty: "vendor-1",
        task_id: "task-1",
      },
    });
    const settled = parseJson(settleResult as ToolTextResult);
    expect(settled.status).toBe("settled");

    // 4. Overspend — ask for more than the remaining 2500.
    const overspendResult = (await client.callTool({
      name: "settle",
      arguments: {
        entitlement_id: child.entitlement_id,
        amount: "999999",
        counterparty: "vendor-1",
        task_id: "task-1",
      },
    })) as ToolTextResult;

    expect(overspendResult.isError).toBe(true);
    const rejection = parseJson(overspendResult);
    // Structured: code, entitlement_id, and available amount to retry with —
    // not just a bare message (PHASE3.md "A" requirement).
    expect(rejection.code).toBe("INSUFFICIENT_ENTITLEMENT");
    expect(rejection.entitlement_id).toBe(child.entitlement_id);
    expect(rejection.available).toBe("2500");

    // 5. check_balance confirms the overspend attempt changed nothing.
    const balanceResult = await client.callTool({
      name: "check_balance",
      arguments: { entitlement_id: child.entitlement_id },
    });
    const balance = parseJson(balanceResult as ToolTextResult);
    expect(balance.available).toBe("2500");

    // 6. The pool-status resource reflects the real settlement.
    const poolStatus = await client.readResource({ uri: "treasury://pool/status" });
    const pool = JSON.parse(resourceText(poolStatus.contents));
    expect(BigInt(pool.granted)).toBeGreaterThanOrEqual(10000n);
  });

  it("rejects a request against an unknown parent with structured context, not a stack trace", async () => {
    const result = (await client.callTool({
      name: "request_entitlement",
      arguments: { agent_id: "ghost", amount: "1", ttl_seconds: 60, parent_id: "ent_does_not_exist" },
    })) as ToolTextResult;

    expect(result.isError).toBe(true);
    const rejection = parseJson(result);
    expect(rejection.message).toBeTruthy();
  });
});

describe("--sim mode: pre-populated demo entitlements", () => {
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    transport = new StdioClientTransport({
      command: "npx",
      args: ["tsx", "src/server.ts", "--sim"],
      cwd: process.cwd(),
    });
    client = new Client({ name: "test-client-sim", version: "0.0.1" });
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    await client.close();
  });

  it("has demo entitlements ready to query with no prior request_entitlement call", async () => {
    // A fresh process's entitlement id counter starts at ent_1, and sim
    // seeding is the very first thing that runs, so the first seeded demo
    // entitlement is deterministically ent_1.
    const result = await client.callTool({
      name: "check_balance",
      arguments: { entitlement_id: "ent_1" },
    });
    const balance = parseJson(result as ToolTextResult);
    expect(balance.status).toBe("active");
    expect(BigInt(balance.granted)).toBeGreaterThan(0n);

    const entitlementsResult = await client.readResource({
      uri: "treasury://agent/demo-agent-1/entitlements",
    });
    const list = JSON.parse(resourceText(entitlementsResult.contents));
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("ent_1");
  });
});
