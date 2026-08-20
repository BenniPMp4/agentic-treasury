// Per-agent, per-second apportionment. Invariant 12: apportionment sums
// exactly to the pool's total accrual — no yield is created or destroyed
// by attribution.

export interface AccrualWeight {
  agent_id: string;
  /** Capital-time exposure (e.g. minor units held x seconds held), or any
   * other non-negative integer proportional to how much of the accrual
   * this agent should receive. */
  weight: bigint;
}

export interface AccrualShare {
  agent_id: string;
  amount: bigint;
}

/**
 * Apportions `totalAccrual` across agents in proportion to `weight`, using
 * the largest-remainder method (a.k.a. Hamilton apportionment):
 *
 *   1. Give each agent floor(totalAccrual * weight / totalWeight).
 *   2. The floor shares under-allocate by some integer leftover < agentCount.
 *   3. Distribute that leftover one unit at a time to the agents with the
 *      largest fractional remainder, breaking ties by agent_id ascending
 *      (deterministic — required for invariant 16's benchmark reproducibility).
 *
 * This is the documented rounding rule for invariant 12: floating-point
 * proportional division would not guarantee an exact sum, and this does,
 * by construction, for any non-negative integer weights.
 */
export function apportionAccrual(totalAccrual: bigint, weights: AccrualWeight[]): AccrualShare[] {
  const totalWeight = weights.reduce((sum, w) => sum + w.weight, 0n);
  if (weights.length === 0 || totalWeight === 0n) {
    return weights.map((w) => ({ agent_id: w.agent_id, amount: 0n }));
  }

  const floors = weights.map((w) => {
    const product = totalAccrual * w.weight;
    return {
      agent_id: w.agent_id,
      amount: product / totalWeight,
      remainder: product % totalWeight,
    };
  });

  const allocated = floors.reduce((sum, f) => sum + f.amount, 0n);
  let leftover = totalAccrual - allocated;

  const byRemainderDesc = [...floors].sort((a, b) => {
    if (a.remainder !== b.remainder) return a.remainder > b.remainder ? -1 : 1;
    return a.agent_id < b.agent_id ? -1 : a.agent_id > b.agent_id ? 1 : 0;
  });

  const bump = new Set<string>();
  for (const f of byRemainderDesc) {
    if (leftover <= 0n) break;
    bump.add(f.agent_id);
    leftover -= 1n;
  }

  return floors.map((f) => ({ agent_id: f.agent_id, amount: f.amount + (bump.has(f.agent_id) ? 1n : 0n) }));
}
