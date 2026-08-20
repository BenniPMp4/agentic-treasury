// Declare, reserve, expire — the yield layer's view of intents. Distinct
// from src/intents.ts (Phase 1's per-entitlement hot-buffer reservation
// against the Pool): this engine buckets intents by execution window so
// src/intent/buffer.ts's formula can ask "what's COMMITTED right now" and
// "what's PROBABLE right now" without re-deriving that from scratch.

export type YieldIntentClass = "COMMITTED" | "PROBABLE" | "SPECULATIVE";
export type YieldIntentStatus = "active" | "expired" | "consumed";

export interface YieldIntent {
  id: string;
  agent_id: string;
  amount: bigint;
  class: YieldIntentClass;
  /** Only meaningful for PROBABLE; ignored otherwise. */
  probability?: number;
  windowStart: number;
  windowEnd: number;
  status: YieldIntentStatus;
}

export interface DeclareYieldIntentParams {
  agent_id: string;
  amount: bigint;
  class: YieldIntentClass;
  probability?: number;
  windowStart: number;
  windowEnd: number;
}

/** Default probability weight for a PROBABLE intent that didn't declare
 * its own. Configurable per-intent because declared probability, where an
 * agent supplies one, is a strictly better signal than a fleet-wide
 * constant — see PHASE3.md's buffer formula and its sensitivity sweep. */
export const DEFAULT_PROBABLE_P = 0.6;

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `yint_${idCounter}`;
}

export class IntentEngine {
  private byId = new Map<string, YieldIntent>();

  declare(params: DeclareYieldIntentParams): YieldIntent {
    const intent: YieldIntent = {
      id: nextId(),
      agent_id: params.agent_id,
      amount: params.amount,
      class: params.class,
      probability: params.probability,
      windowStart: params.windowStart,
      windowEnd: params.windowEnd,
      status: "active",
    };
    this.byId.set(intent.id, intent);
    return intent;
  }

  get(id: string): YieldIntent {
    const intent = this.byId.get(id);
    if (!intent) throw new Error(`Unknown yield intent: ${id}`);
    return intent;
  }

  /** Marks every active intent whose window has fully passed as expired.
   * Returns the ones just expired. */
  expire(now: number): YieldIntent[] {
    const justExpired: YieldIntent[] = [];
    for (const intent of this.byId.values()) {
      if (intent.status === "active" && now > intent.windowEnd) {
        intent.status = "expired";
        justExpired.push(intent);
      }
    }
    return justExpired;
  }

  consume(id: string): YieldIntent {
    const intent = this.get(id);
    intent.status = "consumed";
    return intent;
  }

  private activeInWindow(now: number, cls: YieldIntentClass): YieldIntent[] {
    return [...this.byId.values()].filter(
      (i) => i.status === "active" && i.class === cls && i.windowStart <= now && now <= i.windowEnd
    );
  }

  /** Exact sum — this feeds requiredHotBuffer's non-negotiable term. */
  committedInWindow(now: number): bigint {
    return this.activeInWindow(now, "COMMITTED").reduce((sum, i) => sum + i.amount, 0n);
  }

  probableInWindow(now: number): { agent_id: string; amount: bigint; probability: number }[] {
    return this.activeInWindow(now, "PROBABLE").map((i) => ({
      agent_id: i.agent_id,
      amount: i.amount,
      probability: i.probability ?? DEFAULT_PROBABLE_P,
    }));
  }
}
