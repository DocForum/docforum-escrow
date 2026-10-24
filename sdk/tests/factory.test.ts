import { describe, expect, it } from "vitest";
import { Address, Keypair, StrKey } from "@stellar/stellar-sdk";
import { FactoryClient, predictInstanceAddress, randomSalt } from "../src/factory.js";

// A valid contract id used as a stand-in factory id for offline derivation
// tests. Derived as StrKey.encodeContract(sha256("docforum-escrow-factory")).
const FACTORY_ID = "CBCYSOQ3HKYQDHLSHTFNIAA7X2NUGJVYOCN24DCVT46VG4YI6DMNARMD";

const SALT = Uint8Array.from(
  Buffer.from("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", "hex"),
);

// Golden vector for the derivation on Stellar testnet. Pinned so a refactor
// cannot silently change every integrator's instance address.
const TESTNET_GOLDEN = "CCRBCMHNL2P3VGGSXR6RSQ7FUHBOSJEDPFBS5I6WPT65ZVOGX2RDE5RS";

describe("predictInstanceAddress", () => {
  it("derives the pinned testnet address for a known factory and salt", () => {
    expect(predictInstanceAddress(FACTORY_ID, SALT)).toBe(TESTNET_GOLDEN);
  });

  it("returns a valid contract address", () => {
    const predicted = predictInstanceAddress(FACTORY_ID, SALT);
    expect(StrKey.isValidContract(predicted)).toBe(true);
    expect(() => new Address(predicted)).not.toThrow();
  });

  it("binds the derivation to the network passphrase", () => {
    const futurenet = predictInstanceAddress(
      FACTORY_ID,
      SALT,
      "Test SDF Future Network ; October 2022",
    );
    expect(futurenet).not.toBe(TESTNET_GOLDEN);
    expect(StrKey.isValidContract(futurenet)).toBe(true);
  });

  it("is deterministic and salt-sensitive", () => {
    const a1 = predictInstanceAddress(FACTORY_ID, Uint8Array.from([...SALT]));
    const a2 = predictInstanceAddress(FACTORY_ID, Uint8Array.from([...SALT]));
    const b = predictInstanceAddress(FACTORY_ID, new Uint8Array(32).fill(2));
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
  });

  it("rejects a salt that is not 32 bytes", () => {
    expect(() => predictInstanceAddress(FACTORY_ID, new Uint8Array(16))).toThrow(TypeError);
  });

  it("rejects an empty factory id", () => {
    expect(() => predictInstanceAddress("", SALT)).toThrow(TypeError);
  });

  it("rejects a factory id that is not a contract id", () => {
    expect(() => predictInstanceAddress(Keypair.random().publicKey(), SALT)).toThrow(TypeError);
  });
});

describe("randomSalt", () => {
  it("returns 32 bytes and varies between calls", () => {
    const a = randomSalt();
    const b = randomSalt();
    expect(a).toHaveLength(32);
    expect(b).toHaveLength(32);
    expect(a).not.toEqual(b);
  });
});

describe("FactoryClient", () => {
  it("requires a factoryId", () => {
    expect(() => new FactoryClient({ factoryId: "" })).toThrow(TypeError);
  });

  it("exposes the configured network so instances can be built consistently", () => {
    const client = new FactoryClient({ factoryId: FACTORY_ID, rpcUrl: "https://example.invalid" });
    expect(client.rpcUrl).toBe("https://example.invalid");
    expect(client.networkPassphrase).toContain("Test SDF Network");
  });

  it("derives the same instance address from a given salt as predictInstanceAddress", () => {
    const client = new FactoryClient({ factoryId: FACTORY_ID });
    expect(predictInstanceAddress(client.factoryId, SALT, client.networkPassphrase)).toBe(
      TESTNET_GOLDEN,
    );
  });

  it("forIntegrator throws when no instance is deployed", async () => {
    const client = new FactoryClient({ factoryId: FACTORY_ID });
    const integrator = Keypair.random().publicKey();
    // Stub the network call so this test stays offline.
    (client as unknown as { getInstance: (i: string) => Promise<null> }).getInstance = async () => null;
    await expect(client.forIntegrator(integrator)).rejects.toThrow(/no instance deployed/);
  });
});
