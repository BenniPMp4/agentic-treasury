import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryLedger, TreasuryError } from "../src/ledger.js";
import { EntitlementStore } from "../src/entitlements.js";
import { IntentStore } from "../src/intents.js";
import { SettlementService } from "../src/settlement.js";

// Deterministic clock. Every call takes an explicit `now` so tests never
// depend on wall-clock timing.
const NOW = Date.parse("2026-01-01T00:00:00Z");
const TENANT = "test-tenant";

function setup(poolTotal = 100_000n) {
  const ledger = new InMemoryLedger();
  ledger.createPool(TENANT, poolTotal);
  const entitlements = new EntitlementStore(ledger);
  const intents = new IntentStore(ledger, entitlements);
  const settlement = new SettlementService(ledger, entitlements, intents);
  return { ledger, entitlements, intents, settlement };
}

function expectRejection(fn: () => unknown, code: string) {
  try {
    fn();
    expect.fail(`expected rejection ${code} but call succeeded`);
  } catch (err) {
    expect(err).toBeInstanceOf(TreasuryError);
    expect((err as TreasuryError).code).toBe(code);
  }
}

describe("Invariant 1: amount_spent + amount_delegated <= amount_granted", () => {
  it("rejects a settlement that would push spent+delegated past granted", () => {
    const { entitlements, intents, settlement } = setup();
    const root = entitlements.request({
      tenantId: TENANT,
      agent_id: "agent-a",
      amount: 1_000n,
      ttl_seconds: 3600,
      now: NOW,
    });

    // Delegate 600 to a child, leaving 400 unallocated on the root.
    entitlements.request({
      tenantId: TENANT,
      agent_id: "agent-b",
      amount: 600n,
      ttl_seconds: 1800,
      parent_id: root.id,
      now: NOW,
    });

    expectRejection(
      () =>
        settlement.settle(
          {
            entitlement_id: root.id,
            amount: 500n,
            counterparty: "vendor-x",
            task_id: "task-1",
          },
          NOW
        ),
      "INSUFFICIENT_ENTITLEMENT"
    );

    const bal = entitlements.checkBalance(root.id, NOW);
    expect(bal.spent + bal.delegated <= bal.granted).toBe(true);
  });
});

describe("Invariant 2: a child's amount_granted can never exceed the parent's unallocated remainder", () => {
  it("rejects delegation beyond what the parent has left", () => {
    const { entitlements } = setup();
    const root = entitlements.request({
      tenantId: TENANT,
      agent_id: "agent-a",
      amount: 1_000n,
      ttl_seconds: 3600,
      now: NOW,
    });

    entitlements.request({
      tenantId: TENANT,
      agent_id: "agent-b",
      amount: 700n,
      ttl_seconds: 1800,
      parent_id: root.id,
      now: NOW,
    });

    expectRejection(
      () =>
        entitlements.request({
          tenantId: TENANT,
          agent_id: "agent-c",
          amount: 400n,
          ttl_seconds: 1800,
          parent_id: root.id,
          now: NOW,
        }),
      "PARENT_INSUFFICIENT"
    );
  });
});

describe("Invariant 3: a child's expires_at can never exceed its parent's expires_at", () => {
  it("rejects a child TTL that would outlive the parent", () => {
    const { entitlements } = setup();
    const root = entitlements.request({
      tenantId: TENANT,
      agent_id: "agent-a",
      amount: 1_000n,
      ttl_seconds: 3600,
      now: NOW,
    });

    expectRejection(
      () =>
        entitlements.request({
          tenantId: TENANT,
          agent_id: "agent-b",
          amount: 100n,
          ttl_seconds: 7200,
          parent_id: root.id,
          now: NOW,
        }),
      "EXPIRY_EXCEEDS_PARENT"
    );
  });
});

describe("Invariant 4: no settlement without an active, unexpired entitlement with sufficient remainder", () => {
  it("rejects settlement against an expired entitlement", () => {
    const { entitlements, settlement } = setup();
    const ent = entitlements.request({
      tenantId: TENANT,
      agent_id: "agent-a",
      amount: 500n,
      ttl_seconds: 1,
      now: NOW,
    });

    const later = NOW + 2_000;
    expectRejection(
      () =>
        settlement.settle(
          {
            entitlement_id: ent.id,
            amount: 100n,
            counterparty: "vendor-x",
            task_id: "task-1",
          },
          later
        ),
      "ENTITLEMENT_EXPIRED"
    );
  });

  it("rejects settlement against a revoked entitlement", () => {
    const { entitlements, settlement } = setup();
    const ent = entitlements.request({
      tenantId: TENANT,
      agent_id: "agent-a",
      amount: 500n,
      ttl_seconds: 3600,
      now: NOW,
    });
    entitlements.revoke(ent.id, NOW);

    expectRejection(
      () =>
        settlement.settle(
          {
            entitlement_id: ent.id,
            amount: 100n,
            counterparty: "vendor-x",
            task_id: "task-1",
          },
          NOW
        ),
      "ENTITLEMENT_REVOKED"
    );
  });

  it("rejects settlement that exceeds the remaining balance", () => {
    const { entitlements, settlement } = setup();
    const ent = entitlements.request({
      tenantId: TENANT,
      agent_id: "agent-a",
      amount: 500n,
      ttl_seconds: 3600,
      now: NOW,
    });

    expectRejection(
      () =>
        settlement.settle(
          {
            entitlement_id: ent.id,
            amount: 501n,
            counterparty: "vendor-x",
            task_id: "task-1",
          },
          NOW
        ),
      "INSUFFICIENT_ENTITLEMENT"
    );
  });
});

describe("Invariant 5: on expiry or revocation, unspent amount returns to the parent (or Pool) atomically", () => {
  it("rejects a root grant larger than the pool", () => {
    const { entitlements } = setup(1_000n);
    expectRejection(
      () =>
        entitlements.request({
          tenantId: TENANT,
          agent_id: "agent-a",
          amount: 2_000n,
          ttl_seconds: 3600,
          now: NOW,
        }),
      "POOL_INSUFFICIENT"
    );
  });

  it("returns unspent capital to the pool on revocation", () => {
    const { ledger, entitlements } = setup(10_000n);
    const before = ledger.getPool(TENANT);
    expect(before.total - before.reserved - before.granted).toBe(10_000n);

    const root = entitlements.request({
      tenantId: TENANT,
      agent_id: "agent-a",
      amount: 2_000n,
      ttl_seconds: 3600,
      now: NOW,
    });
    const mid = ledger.getPool(TENANT);
    expect(mid.total - mid.reserved - mid.granted).toBe(8_000n);

    const { returned_amount } = entitlements.revoke(root.id, NOW);
    expect(returned_amount).toBe(2_000n);

    const after = ledger.getPool(TENANT);
    expect(after.total - after.reserved - after.granted).toBe(10_000n);
  });

  it("returns unspent capital to the pool on lazy expiry", () => {
    const { ledger, entitlements } = setup(10_000n);
    entitlements.request({
      tenantId: TENANT,
      agent_id: "agent-a",
      amount: 1_500n,
      ttl_seconds: 1,
      now: NOW,
    });

    const later = NOW + 5_000;
    // Touching the store after expiry should trigger the atomic reclaim.
    const ents = entitlements.listByAgent("agent-a", later);
    expect(ents[0]!.status).toBe("expired");

    const pool = ledger.getPool(TENANT);
    expect(pool.total - pool.reserved - pool.granted).toBe(10_000n);
  });
});

describe("Invariant 6: revoking an entitlement revokes its entire subtree, depth-first, in one transaction", () => {
  it("cascades revocation through grandchildren and reclaims everything unspent", () => {
    const { entitlements, settlement } = setup();
    const root = entitlements.request({
      tenantId: TENANT,
      agent_id: "agent-a",
      amount: 1_000n,
      ttl_seconds: 3600,
      now: NOW,
    });
    const child = entitlements.request({
      tenantId: TENANT,
      agent_id: "agent-b",
      amount: 600n,
      ttl_seconds: 1800,
      parent_id: root.id,
      now: NOW,
    });
    const grandchild = entitlements.request({
      tenantId: TENANT,
      agent_id: "agent-c",
      amount: 200n,
      ttl_seconds: 900,
      parent_id: child.id,
      now: NOW,
    });
    // Grandchild spends a bit, so that amount is *not* reclaimable.
    settlement.settle(
      {
        entitlement_id: grandchild.id,
        amount: 50n,
        counterparty: "vendor-x",
        task_id: "task-1",
      },
      NOW
    );

    const { revoked_count, returned_amount } = entitlements.revoke(root.id, NOW);

    expect(revoked_count).toBe(3);
    // root(1000) + child(600) + grandchild(200) - the 50 already spent.
    expect(returned_amount).toBe(1_000n - 50n);

    for (const id of [root.id, child.id, grandchild.id]) {
      expect(entitlements.get(id, NOW).status).toBe("revoked");
    }
  });
});

describe("Invariant 7: a child's counterparty_allow must be a subset of its parent's", () => {
  it("rejects a child allow-list that adds a counterparty the parent didn't allow", () => {
    const { entitlements } = setup();
    const root = entitlements.request({
      tenantId: TENANT,
      agent_id: "agent-a",
      amount: 1_000n,
      ttl_seconds: 3600,
      counterparty_allow: ["stripe", "aws"],
      now: NOW,
    });

    expectRejection(
      () =>
        entitlements.request({
          tenantId: TENANT,
          agent_id: "agent-b",
          amount: 100n,
          ttl_seconds: 1800,
          parent_id: root.id,
          counterparty_allow: ["stripe", "openai"],
          now: NOW,
        }),
      "COUNTERPARTY_NOT_ALLOWED"
    );
  });

  it("allows a child allow-list that narrows the parent's", () => {
    const { entitlements } = setup();
    const root = entitlements.request({
      tenantId: TENANT,
      agent_id: "agent-a",
      amount: 1_000n,
      ttl_seconds: 3600,
      counterparty_allow: ["stripe", "aws"],
      now: NOW,
    });

    const child = entitlements.request({
      tenantId: TENANT,
      agent_id: "agent-b",
      amount: 100n,
      ttl_seconds: 1800,
      parent_id: root.id,
      counterparty_allow: ["stripe"],
      now: NOW,
    });
    expect(child.counterparty_allow).toEqual(["stripe"]);
  });
});

describe("Invariant 8: every settlement is double-entry and the ledger always balances", () => {
  it("debits the agent and credits the counterparty by equal amounts", () => {
    const { ledger, entitlements, settlement } = setup();
    const ent = entitlements.request({
      tenantId: TENANT,
      agent_id: "agent-a",
      amount: 1_000n,
      ttl_seconds: 3600,
      now: NOW,
    });

    settlement.settle(
      {
        entitlement_id: ent.id,
        amount: 300n,
        counterparty: "vendor-x",
        task_id: "task-1",
      },
      NOW
    );
    settlement.settle(
      {
        entitlement_id: ent.id,
        amount: 150n,
        counterparty: "vendor-y",
        task_id: "task-1",
      },
      NOW
    );

    expect(ledger.getAccountBalance("agent-a")).toBe(-450n);
    expect(ledger.getAccountBalance("vendor-x")).toBe(300n);
    expect(ledger.getAccountBalance("vendor-y")).toBe(150n);
    expect(ledger.isBalanced()).toBe(true);
  });
});

describe("Invariant 9: intents reserve against the Pool's hot buffer, never amount_granted; expiry releases the reservation", () => {
  it("reserves pool capacity without touching the entitlement's granted amount", () => {
    const { ledger, entitlements, intents } = setup(5_000n);
    const ent = entitlements.request({
      tenantId: TENANT,
      agent_id: "agent-a",
      amount: 1_000n,
      ttl_seconds: 3600,
      now: NOW,
    });

    const { reserved } = intents.declare(
      {
        entitlement_id: ent.id,
        amount: 300n,
        class: "PROBABLE",
      },
      NOW
    );
    expect(reserved).toBe(300n);

    const pool = ledger.getPool(TENANT);
    expect(pool.reserved).toBe(300n);
    expect(entitlements.get(ent.id, NOW).amount_granted).toBe(1_000n);
  });

  it("releases the hot-buffer reservation once the intent expires", () => {
    const { ledger, entitlements, intents } = setup(5_000n);
    const ent = entitlements.request({
      tenantId: TENANT,
      agent_id: "agent-a",
      amount: 1_000n,
      ttl_seconds: 3600,
      now: NOW,
    });

    const { intent_id } = intents.declare(
      {
        entitlement_id: ent.id,
        amount: 300n,
        class: "SPECULATIVE",
        latest: NOW + 1_000,
      },
      NOW
    );

    expect(ledger.getPool(TENANT).reserved).toBe(300n);

    const later = NOW + 5_000;
    const released = intents.releaseIfExpired(intent_id, later);
    expect(released).toBe(true);
    expect(ledger.getPool(TENANT).reserved).toBe(0n);
  });
});

describe("Invariant 10: delegation depth is capped at 5", () => {
  it("allows exactly five levels of delegation and rejects a sixth", () => {
    const { entitlements } = setup();
    let parent = entitlements.request({
      tenantId: TENANT,
      agent_id: "agent-0",
      amount: 10_000n,
      ttl_seconds: 36_000,
      now: NOW,
    });
    expect(parent.depth).toBe(1);

    for (let level = 2; level <= 5; level++) {
      parent = entitlements.request({
        tenantId: TENANT,
        agent_id: `agent-${level}`,
        amount: 10n,
        ttl_seconds: 3600,
        parent_id: parent.id,
        now: NOW,
      });
      expect(parent.depth).toBe(level);
    }

    expectRejection(
      () =>
        entitlements.request({
          tenantId: TENANT,
          agent_id: "agent-6",
          amount: 1n,
          ttl_seconds: 3600,
          parent_id: parent.id,
          now: NOW,
        }),
      "DELEGATION_TOO_DEEP"
    );
  });
});
