/**
 * Offline unit tests for the Stellar Wallets Kit adapter (issue #127).
 * A fake kit stands in for `@creit.tech/stellar-wallets-kit`, so this suite
 * never imports the wallet package and runs in CI without a browser.
 */
import { describe, expect, it, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { signerAddress } from "../src/signers/types.js";
import {
  WalletsKitSigner,
  type WalletsKitLike,
} from "../src/signers/wallets-kit.js";
import {
  WALLET_USER_REJECTED,
  WalletNetworkMismatchError,
  WalletSigningUnsupportedError,
} from "../src/signers/types.js";

const TESTNET = "Test SDF Network ; September 2015";
const MAINNET = "Public Global Stellar Network ; September 2015";

function fakeKit(overrides: Partial<WalletsKitLike> = {}): WalletsKitLike & {
  signTransaction: ReturnType<typeof vi.fn>;
  getNetwork: ReturnType<typeof vi.fn>;
  getAddress: ReturnType<typeof vi.fn>;
} {
  return {
    getAddress: vi.fn(async () => ({ address: Keypair.random().publicKey() })),
    getNetwork: vi.fn(async () => ({ network: "TESTNET", networkPassphrase: TESTNET })),
    signTransaction: vi.fn(async () => ({ signedTxXdr: "signed-envelope", signerAddress: undefined })),
    ...overrides,
  } as never;
}

describe("WalletsKitSigner", () => {
  it("connects by resolving the active wallet address", async () => {
    const address = Keypair.random().publicKey();
    const kit = fakeKit({ getAddress: vi.fn(async () => ({ address })) });

    const signer = await WalletsKitSigner.connect({ kit, networkPassphrase: TESTNET });

    expect(signer.address).toBe(address);
    expect(signerAddress(signer)).toBe(address);
  });

  it("signs with the connected address and the configured network", async () => {
    const address = Keypair.random().publicKey();
    const kit = fakeKit();
    const signer = new WalletsKitSigner({ kit, address, networkPassphrase: TESTNET });

    const result = await signer.signTransaction("unsigned-envelope");

    expect(result).toEqual({ signedTxXdr: "signed-envelope", signerAddress: address });
    expect(kit.signTransaction).toHaveBeenCalledWith("unsigned-envelope", {
      address,
      networkPassphrase: TESTNET,
    });
  });

  it("throws a typed error before signing when the wallet is on another network", async () => {
    const kit = fakeKit({
      getNetwork: vi.fn(async () => ({ network: "PUBLIC", networkPassphrase: MAINNET })),
    });
    const signer = new WalletsKitSigner({
      kit,
      address: Keypair.random().publicKey(),
      networkPassphrase: TESTNET,
    });

    const attempt = signer.signTransaction("unsigned-envelope");
    await expect(attempt).rejects.toBeInstanceOf(WalletNetworkMismatchError);
    await expect(attempt).rejects.toMatchObject({
      expectedNetworkPassphrase: TESTNET,
      actualNetworkPassphrase: MAINNET,
    });
    expect(kit.signTransaction).not.toHaveBeenCalled();
  });

  it("falls back to the wallet's network name when no passphrase is reported", async () => {
    const kit = fakeKit({ getNetwork: vi.fn(async () => ({ network: "PUBLIC" })) });
    const signer = new WalletsKitSigner({
      kit,
      address: Keypair.random().publicKey(),
      networkPassphrase: TESTNET,
    });

    await expect(signer.signTransaction("x")).rejects.toBeInstanceOf(WalletNetworkMismatchError);
  });

  it("does not block signing when a wallet cannot report its network", async () => {
    const kit = fakeKit({ getNetwork: vi.fn(async () => { throw new Error("not supported"); }) });
    const signer = new WalletsKitSigner({
      kit,
      address: Keypair.random().publicKey(),
      networkPassphrase: TESTNET,
    });

    await expect(signer.signTransaction("x")).resolves.toMatchObject({ signedTxXdr: "signed-envelope" });
  });

  it("returns user rejection as a normal outcome instead of throwing", async () => {
    const kit = fakeKit({
      signTransaction: vi.fn(async () => { throw { code: -4, message: "User declined access" }; }),
    });
    const signer = new WalletsKitSigner({
      kit,
      address: Keypair.random().publicKey(),
      networkPassphrase: TESTNET,
    });

    const result = await signer.signTransaction("x");

    expect(result).toEqual({
      signedTxXdr: "",
      error: { code: WALLET_USER_REJECTED, message: expect.stringMatching(/rejected/i) },
    });
  });

  it("recognises rejection by message when the wallet omits the code", async () => {
    const kit = fakeKit({
      signTransaction: vi.fn(async () => { throw new Error("Request was rejected by the user"); }),
    });
    const signer = new WalletsKitSigner({
      kit,
      address: Keypair.random().publicKey(),
      networkPassphrase: TESTNET,
    });

    await expect(signer.signTransaction("x")).resolves.toMatchObject({
      error: { code: WALLET_USER_REJECTED },
    });
  });

  it("rethrows non-rejection wallet failures", async () => {
    const kit = fakeKit({
      signTransaction: vi.fn(async () => { throw new Error("wallet exploded"); }),
    });
    const signer = new WalletsKitSigner({
      kit,
      address: Keypair.random().publicKey(),
      networkPassphrase: TESTNET,
    });

    await expect(signer.signTransaction("x")).rejects.toThrow("wallet exploded");
  });

  it("signs auth entries and treats rejection as a normal outcome", async () => {
    const address = Keypair.random().publicKey();
    const signAuthEntry = vi.fn(async () => ({ signedAuthEntry: "signed-auth", signerAddress: address }));
    const kit = fakeKit({ signAuthEntry });
    const signer = new WalletsKitSigner({ kit, address, networkPassphrase: TESTNET });

    await expect(signer.signAuthEntry("entry")).resolves.toEqual({
      signedAuthEntry: "signed-auth",
      signerAddress: address,
    });

    signAuthEntry.mockRejectedValueOnce({ code: -4, message: "rejected" });
    await expect(signer.signAuthEntry("entry")).resolves.toMatchObject({
      error: { code: WALLET_USER_REJECTED },
    });
  });

  it("throws a typed error when the wallet cannot sign auth entries", async () => {
    const signer = new WalletsKitSigner({
      kit: fakeKit(),
      address: Keypair.random().publicKey(),
      networkPassphrase: TESTNET,
    });

    await expect(signer.signAuthEntry("entry")).rejects.toBeInstanceOf(WalletSigningUnsupportedError);
  });

  it("works with a local Keypair through the shared address helper", () => {
    const keypair = Keypair.random();
    expect(signerAddress(keypair)).toBe(keypair.publicKey());
  });
});
