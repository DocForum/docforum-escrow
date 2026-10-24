import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The same integration suite runs against live testnet
    // (`npm run test:integration`) and a local quickstart network
    // (`npm run test:integration:local`, what CI runs): real transaction
    // round trips and Friendbot funding are slower than the offline suites.
    // The timeout-refund test overrides this with its own budget, since it
    // waits on the network's ledger clock.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
