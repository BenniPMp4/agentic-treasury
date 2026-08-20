// Required hot balance. Invariant 13: the hot buffer must at all times
// cover every COMMITTED intent inside its execution window. A breach is
// recorded, never silently absorbed — BufferGuard.check() both returns a
// boolean *and* durably records the breach, so a caller that only checks
// the return value still can't make a breach disappear from the record.

/**
 * Hot = Σ(COMMITTED in window)
 *     + Σ(PROBABLE × p × reliability_score(agent))
 *     + z · σ(undeclared residual)
 *
 * The COMMITTED term is an exact bigint sum — it's a real obligation, not
 * a statistical estimate, so nothing here is allowed to round it down.
 * The PROBABLE and tail terms are inherently statistical (probabilities,
 * a z-score, a standard deviation) and are rounded *up* (ceiling) when
 * converted back to bigint minor units, so float rounding can only ever
 * push the buffer requirement higher, never lower — the direction that
 * can't cause invariant 13 to be breached by construction.
 */
export const DEFAULT_Z = 2; // ~97.7th percentile under a normal tail, conservative default

export interface ProbableIntent {
  agent_id: string;
  amount: bigint;
  /** Declared/assumed probability this PROBABLE intent actually settles. */
  probability: number;
}

export interface BufferInputs {
  /** Exact sum of COMMITTED intents whose execution window includes now. */
  committedInWindow: bigint;
  probableIntents: ProbableIntent[];
  reliabilityScore: (agentId: string) => number;
  /** σ of the undeclared residual, in minor units. */
  residualStddev: bigint;
  /** Defaults to DEFAULT_Z. */
  z?: number;
}

function ceilToBigint(n: number): bigint {
  return BigInt(Math.ceil(Math.max(0, n)));
}

export function requiredHotBuffer(inputs: BufferInputs): bigint {
  const probableTerm = inputs.probableIntents.reduce((sum, intent) => {
    const weight = intent.probability * inputs.reliabilityScore(intent.agent_id);
    return sum + ceilToBigint(Number(intent.amount) * weight);
  }, 0n);

  const z = inputs.z ?? DEFAULT_Z;
  const tailTerm = ceilToBigint(z * Number(inputs.residualStddev));

  return inputs.committedInWindow + probableTerm + tailTerm;
}

export interface BufferBreach {
  timestamp: number;
  required: bigint;
  available: bigint;
  shortfall: bigint;
}

export class BufferGuard {
  private breaches: BufferBreach[] = [];

  /** Returns true iff `available` covers `required`. Either way, a
   * shortfall (if any) is permanently recorded — see the module comment. */
  check(available: bigint, required: bigint, now: number = Date.now()): boolean {
    if (available >= required) return true;
    this.breaches.push({ timestamp: now, required, available, shortfall: required - available });
    return false;
  }

  getBreaches(): BufferBreach[] {
    return [...this.breaches];
  }

  totalShortfall(): bigint {
    return this.breaches.reduce((sum, b) => sum + b.shortfall, 0n);
  }
}
