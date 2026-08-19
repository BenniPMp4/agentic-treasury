// Simulated agent fleet. Drives many simulated agents drawing on one shared
// pool over a simulated time span, and reports the Phase-1 demo numbers:
//   - total capital reclaimed from expired entitlements
//   - peak vs mean pool utilisation
//   - rejected settlements (and rejected entitlement requests) by rejection code
import { pathToFileURL } from "node:url";
import { InMemoryLedger, TreasuryError, type RejectionCode } from "../ledger.js";
import { EntitlementStore } from "../entitlements.js";
import { IntentStore } from "../intents.js";
import { SettlementService } from "../settlement.js";

const REJECTION_CODES: RejectionCode[] = [
  "ENTITLEMENT_EXPIRED",
  "ENTITLEMENT_REVOKED",
  "INSUFFICIENT_ENTITLEMENT",
  "PARENT_INSUFFICIENT",
  "EXPIRY_EXCEEDS_PARENT",
  "COUNTERPARTY_NOT_ALLOWED",
  "DELEGATION_TOO_DEEP",
  "POOL_INSUFFICIENT",
];

function emptyRejectionCounts(): Record<RejectionCode, number> {
  return Object.fromEntries(REJECTION_CODES.map((c) => [c, 0])) as Record<RejectionCode, number>;
}

function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface FleetOptions {
  agentCount?: number;
  simulatedHours?: number;
  tickMinutes?: number;
  poolTotal?: bigint;
  seed?: number;
}

export interface FleetSummary {
  agentCount: number;
  simulatedHours: number;
  ticks: number;
  poolTotal: bigint;
  entitlementsIssued: number;
  settlementsExecuted: number;
  totalReclaimed: bigint;
  peakUtilisation: number;
  meanUtilisation: number;
  rejectedRequests: Record<RejectionCode, number>;
  rejectedSettlements: Record<RejectionCode, number>;
}

const COUNTERPARTIES = Array.from({ length: 20 }, (_, i) => `vendor-${i + 1}`);

export function runFleet(options: FleetOptions = {}): FleetSummary {
  const agentCount = options.agentCount ?? 1000;
  const simulatedHours = options.simulatedHours ?? 24;
  const tickMinutes = options.tickMinutes ?? 1;
  const poolTotal = options.poolTotal ?? 80_000_000n; // minor units
  const rand = mulberry32(options.seed ?? 42);

  const TENANT = "fleet";
  const ledger = new InMemoryLedger();
  ledger.createPool(TENANT, poolTotal);
  const entitlements = new EntitlementStore(ledger);
  const intents = new IntentStore(ledger, entitlements);
  const settlementSvc = new SettlementService(ledger, entitlements, intents);

  const rejectedRequests = emptyRejectionCounts();
  const rejectedSettlements = emptyRejectionCounts();

  let entitlementsIssued = 0;
  let settlementsExecuted = 0;
  let totalReclaimed = 0n;
  let utilSum = 0;
  let utilPeak = 0;

  const startMs = Date.parse("2026-01-01T00:00:00Z");
  const tickMs = tickMinutes * 60_000;
  const totalTicks = Math.floor((simulatedHours * 60) / tickMinutes);

  // Each simulated agent holds at most one active root entitlement at a time.
  const agentActiveEnt = new Map<number, string>();

  for (let tick = 0; tick < totalTicks; tick++) {
    const now = startMs + tick * tickMs;

    for (let a = 0; a < agentCount; a++) {
      const activeId = agentActiveEnt.get(a);

      if (activeId) {
        // Lazily expires on access; the store returns unspent capital to
        // the pool atomically the moment it notices the entitlement is due.
        const ent = entitlements.get(activeId, now);
        if (ent.status !== "active") {
          totalReclaimed += ent.amount_granted - ent.amount_spent;
          agentActiveEnt.delete(a);
          continue;
        }

        if (rand() < 0.3) {
          const spendAmount = BigInt(1 + Math.floor(rand() * 500));
          try {
            settlementSvc.settle(
              {
                entitlement_id: ent.id,
                amount: spendAmount,
                counterparty: COUNTERPARTIES[Math.floor(rand() * COUNTERPARTIES.length)]!,
                task_id: `task-${a}`,
              },
              now
            );
            settlementsExecuted++;
          } catch (err) {
            if (err instanceof TreasuryError) rejectedSettlements[err.code]++;
            else throw err;
          }
        }

        if (rand() < 0.02) {
          const { returned_amount } = entitlements.revoke(ent.id, now);
          totalReclaimed += returned_amount;
          agentActiveEnt.delete(a);
        }
      } else if (rand() < 0.15) {
        const amount = BigInt(1000 + Math.floor(rand() * 5000));
        const ttlSeconds = (5 + Math.floor(rand() * 55)) * 60; // 5-60 min
        // ~10% of grants are scoped to a couple of counterparties, which
        // occasionally produces a COUNTERPARTY_NOT_ALLOWED settlement below.
        const counterpartyAllow =
          rand() < 0.1
            ? [
                COUNTERPARTIES[Math.floor(rand() * COUNTERPARTIES.length)]!,
                COUNTERPARTIES[Math.floor(rand() * COUNTERPARTIES.length)]!,
              ]
            : undefined;
        try {
          const ent = entitlements.request({
            tenantId: TENANT,
            agent_id: `agent-${a}`,
            amount,
            ttl_seconds: ttlSeconds,
            counterparty_allow: counterpartyAllow,
            now,
          });
          entitlementsIssued++;
          agentActiveEnt.set(a, ent.id);
        } catch (err) {
          if (err instanceof TreasuryError) rejectedRequests[err.code]++;
          else throw err;
        }
      }
    }

    const u = ledger.poolUtilisation(TENANT);
    utilSum += u;
    if (u > utilPeak) utilPeak = u;
  }

  return {
    agentCount,
    simulatedHours,
    ticks: totalTicks,
    poolTotal,
    entitlementsIssued,
    settlementsExecuted,
    totalReclaimed,
    peakUtilisation: utilPeak,
    meanUtilisation: totalTicks > 0 ? utilSum / totalTicks : 0,
    rejectedRequests,
    rejectedSettlements,
  };
}

function formatSummary(s: FleetSummary): string {
  const pct = (n: number) => `${(n * 100).toFixed(2)}%`;
  const codesTable = (label: string, counts: Record<RejectionCode, number>) =>
    [
      `${label}:`,
      ...REJECTION_CODES.filter((c) => counts[c] > 0).map((c) => `    ${c.padEnd(28)} ${counts[c]}`),
      ...(REJECTION_CODES.every((c) => counts[c] === 0) ? ["    (none)"] : []),
    ].join("\n");

  return [
    `Agent Treasury — fleet simulation`,
    `  agents:                 ${s.agentCount}`,
    `  simulated span:         ${s.simulatedHours}h (${s.ticks} ticks)`,
    `  pool total:             ${s.poolTotal.toString()} minor units`,
    ``,
    `  entitlements issued:    ${s.entitlementsIssued}`,
    `  settlements executed:   ${s.settlementsExecuted}`,
    `  capital reclaimed:      ${s.totalReclaimed.toString()} minor units`,
    ``,
    `  peak pool utilisation:  ${pct(s.peakUtilisation)}`,
    `  mean pool utilisation:  ${pct(s.meanUtilisation)}`,
    ``,
    codesTable("rejected entitlement requests", s.rejectedRequests),
    codesTable("rejected settlements", s.rejectedSettlements),
  ].join("\n");
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const summary = runFleet();
  console.log(formatSummary(summary));
}
