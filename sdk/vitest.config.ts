import { defineConfig, defaultExclude } from "vitest/config";

export default defineConfig({
  test: {
    // Real testnet round trips (friendbot funding + transaction
    // finalization) are slower than anything else in this org's test
    // suites — see tests/testnet-integration.test.ts.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Network-dependent integration tests are opt-in (SDK_TESTNET=1)
    // and excluded from the default CI run.
    exclude: [...defaultExclude, "tests/testnet-integration.test.ts"],
  },
});
