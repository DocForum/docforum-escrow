import { defineConfig } from "vitest/config";

/**
 * Futurenet integration run (Phase E7).
 *
 * Only `tests/futurenet-integration.test.ts` runs here, and only from the
 * `Futurenet compatibility checks` workflow against a contract deployed to
 * futurenet. It must never be part of the default suites: futurenet is reset
 * often and the suite is deliberately tolerant of a missing contract.
 */
export default defineConfig({
  test: {
    include: ["tests/futurenet-integration.test.ts"],
    // Deploying and then talking to a real network is slower than any
    // offline suite here.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Serial: the suite shares one funded identity and one contract.
    fileParallelism: false,
  },
});
