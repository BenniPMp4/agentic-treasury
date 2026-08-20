// FundAdapter interface + MockFund with deterministic NAV. No real
// provider — Spiko and Archax slot in behind this interface later;
// nothing above this layer may know which fund it's talking to.
//
// Dealing cut-offs are modelled explicitly, including weekends and bank
// holidays: a redemption requested after cut-off, or on a non-business
// day, settles on the *next* business day's cycle. Funds don't deal on
// weekends; agents don't stop spending. If this only ever advanced by a
// fixed same-day delay, the buffer sizing above it would never be tested
// against the case that actually breaks it.

export interface FundAdapter {
  /** Current annualised rate, in basis points. */
  currentRateBps(now: number): number;
  /** NAV per unit at time `now`, as a float (display/accrual-calc only —
   * settlement amounts are always bigint minor units). */
  navPerUnit(now: number): number;
  /** Milliseconds from a redemption request at `now` until funds are
   * actually available (dealing cycle + cut-off + weekend/holiday aware). */
  settlementDelayMs(now: number): number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Fixed-date (UTC month/day) bank holidays — deliberately small and
 * illustrative, not a full regional calendar. */
const BANK_HOLIDAYS_MM_DD = new Set(["01-01", "12-25"]);

function isBusinessDay(ms: number): boolean {
  const d = new Date(ms);
  const day = d.getUTCDay(); // 0 = Sunday, 6 = Saturday
  if (day === 0 || day === 6) return false;
  const mmdd = `${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  return !BANK_HOLIDAYS_MM_DD.has(mmdd);
}

function startOfUtcDay(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Next business day's start-of-day, strictly after `ms`'s day (or `ms`'s
 * own day if it's already a business day and `inclusive` is true). */
function nextBusinessDayStart(ms: number, inclusive: boolean): number {
  let day = inclusive ? startOfUtcDay(ms) : startOfUtcDay(ms) + DAY_MS;
  while (!isBusinessDay(day)) day += DAY_MS;
  return day;
}

export interface MockFundOptions {
  /** Annualised rate in basis points. Default 400 (4%). */
  rateBps?: number;
  /** UTC hour of the daily dealing cut-off. Default 15 (3pm UTC). */
  cutOffHourUtc?: number;
  /** Starting NAV per unit. Default 1.0. */
  startingNav?: number;
  /** Epoch ms this fund's NAV clock starts from. Default 2026-01-01T00:00:00Z. */
  epochMs?: number;
}

export class MockFund implements FundAdapter {
  private readonly rateBps: number;
  private readonly cutOffHourUtc: number;
  private readonly startingNav: number;
  private readonly epochMs: number;

  constructor(options: MockFundOptions = {}) {
    this.rateBps = options.rateBps ?? 400;
    this.cutOffHourUtc = options.cutOffHourUtc ?? 15;
    this.startingNav = options.startingNav ?? 1;
    this.epochMs = options.epochMs ?? Date.parse("2026-01-01T00:00:00Z");
  }

  currentRateBps(_now: number): number {
    return this.rateBps;
  }

  navPerUnit(now: number): number {
    const yearsElapsed = Math.max(0, now - this.epochMs) / (365 * DAY_MS);
    return this.startingNav * (1 + (this.rateBps / 10_000) * yearsElapsed);
  }

  /** True iff `now` is before today's cut-off on a business day. */
  private beforeCutOffOnBusinessDay(now: number): boolean {
    if (!isBusinessDay(now)) return false;
    const day = new Date(now);
    const cutOff = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), this.cutOffHourUtc);
    return now < cutOff;
  }

  settlementDelayMs(now: number): number {
    const settlesOnStartOfDay = this.beforeCutOffOnBusinessDay(now)
      ? nextBusinessDayStart(now, true) // today, same-day cycle
      : nextBusinessDayStart(now, false); // tomorrow's (or later, if weekend/holiday) business day
    // Settle at the same wall-clock hour as the cut-off, on the resolved day.
    const settleAt = settlesOnStartOfDay + this.cutOffHourUtc * 60 * 60 * 1000;
    return Math.max(0, settleAt - now);
  }
}
