// Shadow rate calc: a signal of how "hot" the pool is right now, and how
// much an agent would save by deferring a SPECULATIVE/PROBABLE intent
// instead of committing capital immediately.
import type { Ledger } from "./ledger.js";

export interface ShadowRate {
  rate_bps: number;
  pool_utilisation: number;
  defer_saving_bps: number;
}

const BASE_RATE_BPS = 20;
const MAX_SURGE_BPS = 180;
const DEFER_SAVING_FACTOR = 0.4;

/**
 * rate_bps rises with utilisation (linear, base -> base+surge as
 * utilisation goes 0 -> 1). defer_saving_bps is the portion of that
 * surge an agent avoids by not reserving capital right now.
 */
export function getShadowRate(ledger: Ledger, tenantId: string): ShadowRate {
  const utilisation = Math.min(1, Math.max(0, ledger.poolUtilisation(tenantId)));
  const rate_bps = Math.round(BASE_RATE_BPS + utilisation * MAX_SURGE_BPS);
  const defer_saving_bps = Math.round(utilisation * MAX_SURGE_BPS * DEFER_SAVING_FACTOR);
  return { rate_bps, pool_utilisation: utilisation, defer_saving_bps };
}
