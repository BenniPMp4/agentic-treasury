// Per-agent scoring from settled outcomes. Invariant 15: reliability
// scores are computed only from settled outcomes — a declaration alone
// never improves a score. Enforced structurally, not just behaviourally:
// this class has no method that takes a mere declaration as input at
// all. The only way to influence a score is recordSettledOutcome(), which
// callers invoke from the settlement path (a real settle/expire outcome),
// never from intent.declare().

/** Conservative default for an agent with no settled history: assume
 * they WILL spend what they declare, since under-buffering (invariant 13)
 * is the failure mode that matters — an unproven agent should cost the
 * buffer more, not less, until real settled history says otherwise. */
export const DEFAULT_RELIABILITY = 1;

interface Record_ {
  fulfilled: number;
  total: number;
}

export class ReliabilityScorer {
  private records = new Map<string, Record_>();

  /** Call this from the settlement path only, with whether a COMMITTED or
   * PROBABLE intent's declared spend actually materialised as settled. */
  recordSettledOutcome(agentId: string, fulfilledAsDeclared: boolean): void {
    const rec = this.records.get(agentId) ?? { fulfilled: 0, total: 0 };
    rec.total += 1;
    if (fulfilledAsDeclared) rec.fulfilled += 1;
    this.records.set(agentId, rec);
  }

  score(agentId: string): number {
    const rec = this.records.get(agentId);
    if (!rec || rec.total === 0) return DEFAULT_RELIABILITY;
    return rec.fulfilled / rec.total;
  }
}
