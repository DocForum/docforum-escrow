import { describe, expect, it, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { toContractSigner, type Signer } from "../src/signer.js";
import { RemoteSigner } from "../src/remote-signer.js";

const PASSPHRASE = "Test SDF Network ; September 2015";

describe("pluggable signer adapter", () => {
  it("passes the network passphrase and returns a Stellar SDK signing result", async () => {
    const signer: Signer = {
      publicKey: () => "GTESTSIGNER",
      signTransaction: vi.fn(async (_xdr, _options) => "signed-tx-xdr"),
    };
    const adapted = toContractSigner(signer, PASSPHRASE);
    const signTransaction = adapted.signTransaction as (
      xdr: string,
      options?: { networkPassphrase?: string },
    ) => Promise<{ signedTxXdr: string; signerAddress?: string }>;

    await expect(signTransaction("unsigned-xdr")).resolves.toEqual({
      signedTxXdr: "signed-tx-xdr",
      signerAddress: "GTESTSIGNER",
    });
    expect(signer.signTransaction).toHaveBeenCalledWith("unsigned-xdr", {
      networkPassphrase: PASSPHRASE,
    });
  });

  it("supports an optional auth-entry signer callback", async () => {
    const signer: Signer = {
      publicKey: () => "GTESTSIGNER",
      signTransaction: vi.fn(async () => "signed-tx-xdr"),
      signAuthEntry: vi.fn(async (_xdr, _options) => "signed-auth-entry"),
    };
    const adapted = toContractSigner(signer, PASSPHRASE);
    const signAuthEntry = adapted.signAuthEntry as (
      xdr: string,
      options?: { networkPassphrase?: string },
    ) => Promise<{ signedAuthEntry: string; signerAddress?: string }>;

    await expect(signAuthEntry("auth-entry-xdr")).resolves.toEqual({
      signedAuthEntry: "signed-auth-entry",
      signerAddress: "GTESTSIGNER",
    });
    expect(signer.signAuthEntry).toHaveBeenCalledWith("auth-entry-xdr", {
      networkPassphrase: PASSPHRASE,
    });
  });

  it("does not leak low-level signing errors", async () => {
    const signer: Signer = {
      publicKey: () => "GTESTSIGNER",
      signTransaction: vi.fn(async () => { throw new Error("private signer detail"); }),
    };
    const adapted = toContractSigner(signer, PASSPHRASE);
    const signTransaction = adapted.signTransaction as (
      xdr: string,
    ) => Promise<unknown>;

    await expect(signTransaction("unsigned-xdr")).rejects.toThrow(
      "The configured signer could not sign the transaction.",
    );
  });

  it("preserves the existing Keypair signing path", () => {
    const keypair = Keypair.random();
    const adapted = toContractSigner(keypair, PASSPHRASE);

    expect(adapted.publicKey).toBe(keypair.publicKey());
    expect(adapted.signTransaction).toBe(keypair);
  });
});

describe("RemoteSigner", () => {
  it("sends only unsigned transaction data and the selected network", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ signedXdr: "signed-remote-xdr" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const signer = new RemoteSigner({
      address: "GREMOTE",
      endpoint: "https://signer.example.test/sign",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(signer.signTransaction("unsigned-xdr", { networkPassphrase: PASSPHRASE }))
      .resolves.toBe("signed-remote-xdr");
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://signer.example.test/sign"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          address: "GREMOTE",
          operation: "signTransaction",
          xdr: "unsigned-xdr",
          networkPassphrase: PASSPHRASE,
        }),
      }),
    );
  });

  it("rejects insecure non-local endpoints", () => {
    expect(() => new RemoteSigner({ address: "GREMOTE", endpoint: "http://signer.example.test" }))
      .toThrow("Remote signer endpoints must use HTTPS");
  });
});
