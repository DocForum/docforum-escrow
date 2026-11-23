import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAINNET_NETWORK_PASSPHRASE,
  TESTNET_NETWORK_PASSPHRASE,
  resolveNetworkConfig,
} from "../src/network.ts";

test("defaults to testnet passphrase and endpoints", () => {
  assert.deepEqual(resolveNetworkConfig({}), {
    chainId: TESTNET_NETWORK_PASSPHRASE,
    horizonUrl: "https://horizon-testnet.stellar.org",
    rpcUrl: "https://soroban-testnet.stellar.org",
  });
});

test("uses the endpoint overrides and a custom (non-public) passphrase", () => {
  assert.deepEqual(
    resolveNetworkConfig({
      DOCFORUM_NETWORK_PASSPHRASE: "Standalone Network ; February 2017",
      DOCFORUM_HORIZON_URL: "http://localhost:8000",
      DOCFORUM_RPC_URL: "http://localhost:8000/rpc",
    }),
    {
      chainId: "Standalone Network ; February 2017",
      horizonUrl: "http://localhost:8000",
      rpcUrl: "http://localhost:8000/rpc",
    },
  );
});

test("an empty or missing passphrase falls back to testnet", () => {
  assert.equal(resolveNetworkConfig({ DOCFORUM_NETWORK_PASSPHRASE: "" }).chainId, TESTNET_NETWORK_PASSPHRASE);
});

test("trims surrounding whitespace instead of silently creating a new network", () => {
  assert.deepEqual(
    resolveNetworkConfig({
      DOCFORUM_NETWORK_PASSPHRASE: `  ${TESTNET_NETWORK_PASSPHRASE}  `,
      DOCFORUM_HORIZON_URL: "  https://horizon-testnet.stellar.org  ",
      DOCFORUM_RPC_URL: "  https://soroban-testnet.stellar.org  ",
    }),
    {
      chainId: TESTNET_NETWORK_PASSPHRASE,
      horizonUrl: "https://horizon-testnet.stellar.org",
      rpcUrl: "https://soroban-testnet.stellar.org",
    },
  );
});

test("refuses mainnet unless the opt-in is exactly true", () => {
  const notOptedIn = [
    {},
    { DOCFORUM_ALLOW_MAINNET: "" },
    { DOCFORUM_ALLOW_MAINNET: "TRUE" },
    { DOCFORUM_ALLOW_MAINNET: "1" },
    { DOCFORUM_ALLOW_MAINNET: "yes" },
    { DOCFORUM_ALLOW_MAINNET: "true " },
    // A typo in the flag name must not count as an opt-in.
    { DOCFORUM_ALLOW_MAINTENANCE: "true" },
  ];

  for (const flag of notOptedIn) {
    assert.throws(
      () => resolveNetworkConfig({ DOCFORUM_NETWORK_PASSPHRASE: MAINNET_NETWORK_PASSPHRASE, ...flag }),
      /Refusing to index the Stellar public network/,
    );
  }

  assert.equal(
    resolveNetworkConfig({
      DOCFORUM_NETWORK_PASSPHRASE: MAINNET_NETWORK_PASSPHRASE,
      DOCFORUM_ALLOW_MAINNET: "true",
    }).chainId,
    MAINNET_NETWORK_PASSPHRASE,
  );
});

test("a padded public passphrase cannot bypass the guard", () => {
  for (const passphrase of [
    ` ${MAINNET_NETWORK_PASSPHRASE} `,
    `\t${MAINNET_NETWORK_PASSPHRASE}\t`,
  ]) {
    assert.throws(
      () => resolveNetworkConfig({ DOCFORUM_NETWORK_PASSPHRASE: passphrase }),
      /Refusing to index the Stellar public network/,
    );
  }
});

test("public-network endpoints are refused even when the passphrase is not public", () => {
  for (const endpoints of [
    { DOCFORUM_HORIZON_URL: "https://horizon.stellar.org" },
    { DOCFORUM_RPC_URL: "https://soroban.stellar.org" },
    { DOCFORUM_RPC_URL: "https://mainnet.example.org/rpc" },
    { DOCFORUM_HORIZON_URL: "https://HORIZON.STELLAR.ORG" },
    { DOCFORUM_HORIZON_URL: "horizon.stellar.org" },
  ]) {
    assert.throws(
      () => resolveNetworkConfig(endpoints),
      /Refusing to index the Stellar public network/,
    );
  }

  assert.throws(
    () =>
      resolveNetworkConfig({
        DOCFORUM_RPC_URL: "https://soroban.stellar.org",
        DOCFORUM_ALLOW_MAINNET: "TRUE",
      }),
    /Refusing to index the Stellar public network/,
  );

  const optedIn = {
    DOCFORUM_RPC_URL: "https://soroban.stellar.org",
    DOCFORUM_ALLOW_MAINNET: "true",
  };
  assert.equal(resolveNetworkConfig(optedIn).rpcUrl, "https://soroban.stellar.org");
});

test("a typo in the passphrase variable name cannot select mainnet", () => {
  assert.equal(
    resolveNetworkConfig({
      DOCFORUM_NETWORK_PHRASE: MAINNET_NETWORK_PASSPHRASE,
      DOCFORUM_ALLOW_MAINNET: "true",
    }).chainId,
    TESTNET_NETWORK_PASSPHRASE,
  );
});
