import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Phase 2's chain tests boot an in-process EVM (ganache) and deploy
    // real contracts per test case; comfortably under 30s each on its own,
    // but the default 5s budget gets tight once multiple test files run
    // their own chain concurrently. Phase 1's invariant tests are pure
    // in-memory and finish in milliseconds either way.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
