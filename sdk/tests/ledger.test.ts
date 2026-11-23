import { describe, expect, it, vi } from "vitest";
import { Account, hash, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { LedgerHashSigningDisabledError, LedgerSigner, type LedgerStellarAppLike } from "../src/signers/ledger.js";
import { WALLET_USER_REJECTED, WalletSigningUnsupportedError } from "../src/signers/types.js";

const PATH = "44'/148'/0'";
const TESTNET = Networks.TESTNET;

function fakeApp(overrides: Partial<LedgerStellarAppLike> = {}) {
  const keypair = Keypair.random();
  const app: LedgerStellarAppLike = {
    getPublicKey: vi.fn(async () => ({ rawPublicKey: Buffer.from(keypair.rawPublicKey()) })),
    getAppConfiguration: vi.fn(async () => ({ version: "7.9.0", hashSigningEnabled: true })),
    signTransaction: vi.fn(async (_path, signatureBase) => {
      return { signature: keypair.sign(hash(signatureBase)) };
    }),
    signSorobanAuthorization: vi.fn(async () => ({ signature: Buffer.alloc(64, 7) })),
    ...overrides,
  };
  return { app, keypair };
}

function unsignedTransaction(source: string): string {
  const tx = new TransactionBuilder(new Account(source, "1"), { fee: "100", networkPassphrase: TESTNET })
    .addOperation(Operation.bumpSequence({ bumpTo: "2" }))
    .setTimeout(300)
    .build();
  return tx.toXDR();
}

describe("LedgerSigner", () => {
  it("connects from the Ledger public key and signs an envelope", async () => {
    const { app, keypair } = fakeApp();
    const signer = await LedgerSigner.connect({ app, path: PATH, networkPassphrase: TESTNET });

    expect(signer.address).toBe(keypair.publicKey());
    const result = await signer.signTransaction(unsignedTransaction(keypair.publicKey()));

    expect(result).toMatchObject({ signerAddress: keypair.publicKey() });
    expect(result.signedTxXdr).toBeTruthy();
    expect(app.signTransaction).toHaveBeenCalledWith(PATH, expect.any(Uint8Array));
  });

  it("passes the raw Soroban authorization preimage to the Ledger app", async () => {
    const { app, keypair } = fakeApp();
    const signer = new LedgerSigner({ app, address: keypair.publicKey(), path: PATH, networkPassphrase: TESTNET });
    const preimage = Buffer.from("soroban-preimage").toString("base64");

    const result = await signer.signAuthEntry(preimage);

    expect(result).toMatchObject({ signerAddress: keypair.publicKey(), signedAuthEntry: Buffer.alloc(64, 7).toString("base64") });
    expect(app.signSorobanAuthorization).toHaveBeenCalledWith(PATH, Buffer.from("soroban-preimage"));
  });

  it("explains disabled hash signing before asking the device to sign", async () => {
    const { app, keypair } = fakeApp({
      getAppConfiguration: vi.fn(async () => ({ version: "5.5.0", hashSigningEnabled: false })),
    });
    const signer = new LedgerSigner({ app, address: keypair.publicKey(), path: PATH, networkPassphrase: TESTNET });

    await expect(signer.signTransaction(unsignedTransaction(keypair.publicKey()))).rejects.toBeInstanceOf(LedgerHashSigningDisabledError);
    expect(app.signTransaction).not.toHaveBeenCalled();
  });

  it("returns device rejection as a normal wallet outcome", async () => {
    const { app, keypair } = fakeApp({
      signSorobanAuthorization: vi.fn(async () => { throw { code: -4, message: "User rejected" }; }),
    });
    const signer = new LedgerSigner({ app, address: keypair.publicKey(), path: PATH, networkPassphrase: TESTNET });

    await expect(signer.signAuthEntry("c29tZQ==")).resolves.toMatchObject({ error: { code: WALLET_USER_REJECTED } });
  });

  it("fails clearly when an injected app cannot sign authorization entries", async () => {
    const { app, keypair } = fakeApp();
    delete app.signSorobanAuthorization;
    const signer = new LedgerSigner({ app, address: keypair.publicKey(), path: PATH, networkPassphrase: TESTNET });

    await expect(signer.signAuthEntry("c29tZQ==")).rejects.toBeInstanceOf(WalletSigningUnsupportedError);
  });
});
