// Hot / warm / cold tiering. Invariant 14: the allocation engine may never
// move capital in a way that would breach invariant 13 (the hot buffer
// must always cover every COMMITTED intent in its window). Concretely:
// this module only ever moves capital *out* of hot down to (never below)
// the caller-supplied required buffer. Topping hot back up from warm/cold
// is a redemption with its own dealing delay (src/yield/fund.ts) — not an
// instant move — so it is deliberately not this function's job; a hot
// deficit is a buffer-guard concern (src/intent/buffer.ts), not an
// allocation-engine one.

export interface TierBalances {
  hot: bigint;
  warm: bigint;
  cold: bigint;
}

export interface RebalanceOptions {
  /** Fraction (0..1) of any new hot->warm outflow that continues on into
   * cold, modelling "the bulk of capital sits in warm; a slice of it is
   * long-horizon enough to go further out." Default 0 (everything above
   * the hot requirement stays in warm) — the benchmark can sweep this. */
  coldFraction?: number;
}

export interface RebalanceResult {
  next: TierBalances;
  movedToWarm: bigint;
  movedToCold: bigint;
}

export function rebalanceToTarget(
  current: TierBalances,
  requiredHot: bigint,
  options: RebalanceOptions = {}
): RebalanceResult {
  const coldFraction = options.coldFraction ?? 0;

  const surplus = current.hot > requiredHot ? current.hot - requiredHot : 0n;
  if (surplus === 0n) {
    return { next: { ...current }, movedToWarm: 0n, movedToCold: 0n };
  }

  const movedToCold = (surplus * BigInt(Math.round(coldFraction * 1000))) / 1000n;
  const movedToWarm = surplus - movedToCold;

  return {
    next: {
      hot: current.hot - surplus,
      warm: current.warm + movedToWarm,
      cold: current.cold + movedToCold,
    },
    movedToWarm,
    movedToCold,
  };
}
