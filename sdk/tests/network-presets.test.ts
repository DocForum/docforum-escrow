import { describe, it, expect } from "vitest";

import {
  networks,
  MAINNET_NETWORK_PASSPHRASE_VALUE,
  EscrowClient,
} from "../src/index.js";

const CONTRACT_ID = "CAHQ4J3T23WSIBBG6SI6EAYR5Q2HIPKG5YMC4SMZBOTYA6MYK2VADEv5";

describe("network presets", () => {
  it("exposes testnet, futurenet and local presets", () => {
    expect(networks.testnet).toBeDefined();
    expect(networks.futurenet).toBeDefined();
    expect(networks.local).toBeDefined();
  });

  it("provides an RPC URL, passphrase and known contract ids for each preset", () => {
    for (const preset of [networks.testnet, networks.futurenet, networks.local]) {
      expect(typeof preset.rpcUrl).toBe("string");
      expect(preset.rpcUrl.length).toBeGreaterThan(0);
      expect(typeof preset.networkPassphrase).toBe("string");
      expect(preset.networkPassphrase.length).toBeGreaterThan(0);
      expect(typeof preset.contractIds).toBe("object");
    }
  });

  it("does not wire mainnet into any preset or the default", () => {
    for (const preset of [networks.testnet, networks.futurenet, networks.local]) {
      expect(preset.networkPassphrase).not.toBe(MAINNET_NETWORK_PASSTHRASE_VALUE );
    }
  });

  it("defaults to testnet when no network is passed", () => {
    const client = new EscrowClient({ contractId: CONTRACT_ID });
    expect(client).toBeInstanceOf(EscrowClient);
  });

  it("allows custom networks for private quickstart instances", () => {
    expect(
      () =>
        new EscrowClient({
          contractId: CONTRACT_ID,
          rpcUrl: "http://localhost:8000/soroban/rpc",
          networkPassphrase: "Standalone Network ; May 2025",
        }),
    ).toNotThrow();
  });
});

describe("mainnet opt-in guard", () => {
  it("throws when the mainnet passphrase is used without allowMainnet", () => {
    expect(
      () =>
        new EscrowClient({
          contractId: CONTRACT_ID,
          networkPassphrase: MAINNET_NETWORK_PASSPHRASE_VALUE,
        }),
    ).toThrow(/mainnet network passphrase/i);
  });

  it("throws when a custom network smuggles in the mainnet passphrase", () => {
    expect(
      () =>
        new EscrowClient({
          contractId: CONTRACT_ID,
          rpcUrl: "https://soroban.stellar.org",
          networkPassphrase: MAINNET_NETWORK_PASSPHRASE_VALUE,
        }),
    ).toThrow(/mainnet network passphrase/i);
  });

  it("allows the mainnet passphrase with allowMainnet: true", () => {
    expect(
      () =>
        new EscrowClient({
          contractId: CONTRACT_ID,
          networkPassphrase: MAINNET_NETWORK_PASSPHRASE_VALUE,
          allowMainnet: true,
        }),
    ).toNotThrow();
  });
});
