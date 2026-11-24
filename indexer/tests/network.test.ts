import { describe, expect, it } from "vitest";
import {
  MAINNET_NETWORK_PASSPHRASE,
  TESTNET_NETWORK_PASSPHRASE,
  resolveNetworkConfig,
} from "../src/network";

describe("resolveNetworkConfig", () => {
  it("defaults to testnet passphrase and endpoints", () => {
    expect(resolveNetworkConfig({})).toEqual({
      chainId: TESTNET_NETWORK_PASSPHRASE,
      horizonUrl: "https://horizon-testnet.stellar.org",
      rpcUrl: "https://soroban-testnet.stellar.org",
    });
  });

  it("uses the endpoint overrides and a custom (non-public) passphrase", () => {
    expect(
      resolveNetworkConfig({
        DOCFORUM_NETWORK_PASSPHRASE: "Standalone Network ; February 2017",
        DOCFORUM_HORIZON_URL: "http://localhost:8000",
        DOCFORUM_RPC_URL: "http://localhost:8000/rpc",
      }),
    ).toEqual({
      chainId: "Standalone Network ; February 2017",
      horizonUrl: "http://localhost:8000",
      rpcUrl: "http://localhost:8000/rpc",
    });
  });

  it("an empty or missing passphrase falls back to testnet", () => {
    expect(resolveNetworkConfig({ DOCFORUM_NETWORK_PASSPHRASE: "" }).chainId).toBe(
      TESTNET_NETWORK_PASSPHRASE,
    );
  });

  it("trims surrounding whitespace instead of silently creating a new network", () => {
    expect(
      resolveNetworkConfig({
        DOCFORUM_NETWORK_PASSPHRASE: `  ${TESTNET_NETWORK_PASSPHRASE}  `,
        DOCFORUM_HORIZON_URL: "  https://horizon-testnet.stellar.org  ",
        DOCFORUM_RPC_URL: "  https://soroban-testnet.stellar.org  ",
      }),
    ).toEqual({
      chainId: TESTNET_NETWORK_PASSPHRASE,
      horizonUrl: "https://horizon-testnet.stellar.org",
      rpcUrl: "https://soroban-testnet.stellar.org",
    });
  });

  it("refuses mainnet unless the opt-in is exactly true", () => {
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
      expect(() =>
        resolveNetworkConfig({ DOCFORUM_NETWORK_PASSPHRASE: MAINNET_NETWORK_PASSPHRASE, ...flag }),
      ).toThrow(/Refusing to index the Stellar public network/);
    }

    expect(
      resolveNetworkConfig({
        DOCFORUM_NETWORK_PASSPHRASE: MAINNET_NETWORK_PASSPHRASE,
        DOCFORUM_ALLOW_MAINNET: "true",
      }).chainId,
    ).toBe(MAINNET_NETWORK_PASSPHRASE);
  });

  it("a padded public passphrase cannot bypass the guard", () => {
    for (const passphrase of [
      ` ${MAINNET_NETWORK_PASSPHRASE} `,
      `\t${MAINNET_NETWORK_PASSPHRASE}\t`,
    ]) {
      expect(() => resolveNetworkConfig({ DOCFORUM_NETWORK_PASSPHRASE: passphrase })).toThrow(
        /Refusing to index the Stellar public network/,
      );
    }
  });

  it("public-network endpoints are refused even when the passphrase is not public", () => {
    for (const endpoints of [
      { DOCFORUM_HORIZON_URL: "https://horizon.stellar.org" },
      { DOCFORUM_RPC_URL: "https://soroban.stellar.org" },
      { DOCFORUM_RPC_URL: "https://mainnet.example.org/rpc" },
      { DOCFORUM_HORIZON_URL: "https://HORIZON.STELLAR.ORG" },
      { DOCFORUM_HORIZON_URL: "horizon.stellar.org" },
    ]) {
      expect(() => resolveNetworkConfig(endpoints)).toThrow(
        /Refusing to index the Stellar public network/,
      );
    }

    expect(() =>
      resolveNetworkConfig({
        DOCFORUM_RPC_URL: "https://soroban.stellar.org",
        DOCFORUM_ALLOW_MAINNET: "TRUE",
      }),
    ).toThrow(/Refusing to index the Stellar public network/);

    const optedIn = {
      DOCFORUM_RPC_URL: "https://soroban.stellar.org",
      DOCFORUM_ALLOW_MAINNET: "true",
    };
    expect(resolveNetworkConfig(optedIn).rpcUrl).toBe("https://soroban.stellar.org");
  });

  it("a typo in the passphrase variable name cannot select mainnet", () => {
    expect(
      resolveNetworkConfig({
        DOCFORUM_NETWORK_PHRASE: MAINNET_NETWORK_PASSPHRASE,
        DOCFORUM_ALLOW_MAINNET: "true",
      }).chainId,
    ).toBe(TESTNET_NETWORK_PASSPHRASE);
  });
});
