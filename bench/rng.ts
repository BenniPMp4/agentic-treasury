// The one and only source of randomness anywhere in bench/. Invariant 16
// (determinism) depends entirely on nothing in this tree ever calling
// Math.random() or reading the wall clock — every scenario run creates
// its own mulberry32 instance from the scenario's `seed` and threads it
// explicitly through every function that needs a random draw.

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
