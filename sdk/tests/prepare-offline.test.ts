import { describe, expect, it, vi } from "vitest";
import {
  Account,
  Address,
  Keypair,
  Networks,
  Operation,
  SorobanDataBuilder,
  StrKey,
  Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import {
  EscrowClient,
  OFFLINE_PREPARED_TX_TTL_LEDGERS,
  SignedTransactionMismatchError,
  StaleSequenceError,
} from "../src/index.js";

const CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 7));

function authEntry(address: string, fn: string): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(address).toScAddress(),
        nonce: xdr.Int64.fromString("5"),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(CONTRACT_ID).toScAddress(),
          functionName: fn,
          args: [],
        }),
      ),
      subInvocations: [],
    }),
  });
}

function makeEnvelope(source: string, options: { authAddresses?: string[]; fn?: string; sequence?: string } = {}): string {
  const fn = options.fn ?? "release";
  return new TransactionBuilder(new Account(source, options.sequence ?? "100"), {
    fee: "10000",
    networkPassphrase: Networks.TESTNET,
    timebounds: { minTime: 0, maxTime: Math.floor(Date.now() / 1000) + 300 },
    sorobanData: new SorobanDataBuilder().setResourceFee(1234).build(),
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: CONTRACT_ID,
        function: fn,
        args: [],
        auth: (options.authAddresses ?? []).map((address) => authEntry(address, fn)),
      }),
    )
    .build()
    .toXDR();
}

function sign(envelopeXdr: string, ...signers: Keypair[]): string {
  const tx = TransactionBuilder.fromXDR(envelopeXdr, Networks.TESTNET) as Transaction;
  for (const signer of signers) tx.sign(signer);
  return tx.toXDR();
}

function makeClient(envelope: () => string) {
  const release = vi.fn(async () => ({ isReadCall: false, toXDR: envelope }));
  const refund = vi.fn(async () => ({ isReadCall: false, toXDR: envelope }));
  const rpc = {
    getLatestLedger: vi.fn(async () => ({ sequence: 1_000 })),
    getAccount: vi.fn(async () => ({ sequenceNumber: () => "100" })),
    sendTransaction: vi.fn(async () => ({ status: "PENDING", hash: "outer" })),
    pollTransaction: vi.fn(async () => ({ status: "SUCCESS", returnValue: xdr.ScVal.scvVoid() })),
  };
  const client = Object.assign(new EscrowClient({ contractId: CONTRACT_ID, rpcUrl: "https://127.0.0.1:1" }), {
    rpc,
    publicContractClient: () => ({ release, refund }),
  });
  return { client, release, refund, rpc };
}

describe("prepareRelease / prepareRefund", () => {
  it("builds a release for the releaser, sourced from the releaser, with an offline-length window", async () => {
    const releaser = Keypair.random();
    const { client, release, refund } = makeClient(() => makeEnvelope(releaser.publicKey()));

    const prepared = await client.prepareRelease({ escrowId: 7n, releaser: releaser.publicKey() });

    expect(release).toHaveBeenCalledWith({ escrow_id: 7n, caller: releaser.publicKey() });
    expect(refund).not.toHaveBeenCalled();
    expect(prepared.source).toBe(releaser.publicKey());
    expect(prepared.authSigners).toEqual([]);
    expect(prepared.validUntilLedger).toBe(1_000 + OFFLINE_PREPARED_TX_TTL_LEDGERS);
    const tx = TransactionBuilder.fromXDR(prepared.xdr, Networks.TESTNET) as Transaction;
    expect(tx.ledgerBounds?.maxLedger).toBe(prepared.validUntilLedger);
    expect(tx.signatures).toHaveLength(0);
  });

  it("uses the refund entry point for prepareRefund", async () => {
    const releaser = Keypair.random();
    const { client, release, refund } = makeClient(() => makeEnvelope(releaser.publicKey(), { fn: "refund" }));

    await client.prepareRefund({ escrowId: 3n, releaser: releaser.publicKey() });

    expect(refund).toHaveBeenCalledWith({ escrow_id: 3n, caller: releaser.publicKey() });
    expect(release).not.toHaveBeenCalled();
  });

  it("honours a custom window and lists the releaser as auth signer when a hot account is the source", async () => {
    const releaser = Keypair.random();
    const hot = Keypair.random();
    const { client } = makeClient(() => makeEnvelope(hot.publicKey(), { authAddresses: [releaser.publicKey()] }));

    const prepared = await client.prepareRelease({
      escrowId: 1n,
      releaser: releaser.publicKey(),
      source: hot.publicKey(),
      validForLedgers: 100,
      authValidForLedgers: 5_000,
    });

    expect(prepared.source).toBe(hot.publicKey());
    expect(prepared.authSigners).toEqual([releaser.publicKey()]);
    expect(prepared.validUntilLedger).toBe(1_100);
    expect(prepared.authValidUntilLedger).toBe(6_000);
  });

  it("rejects a bad window before simulating", async () => {
    const { client, release } = makeClient(() => makeEnvelope(Keypair.random().publicKey()));

    await expect(
      client.prepareRelease({ escrowId: 1n, releaser: Keypair.random().publicKey(), validForLedgers: 0 }),
    ).rejects.toThrow(RangeError);
    expect(release).not.toHaveBeenCalled();
  });
});

describe("mergeSignatures", () => {
  const unsigned = (source: string) => makeEnvelope(source);

  it("combines signatures from separate signers into one envelope with the same hash", () => {
    const account = Keypair.random();
    const [a, b, c] = [Keypair.random(), Keypair.random(), Keypair.random()];
    const base = unsigned(account.publicKey());
    const { client } = makeClient(() => base);

    const merged = client.mergeSignatures([sign(base, a), sign(base, b), sign(base, c)]);

    const tx = TransactionBuilder.fromXDR(merged, Networks.TESTNET) as Transaction;
    expect(tx.signatures).toHaveLength(3);
    expect(tx.hash().toString("hex")).toBe(
      (TransactionBuilder.fromXDR(base, Networks.TESTNET) as Transaction).hash().toString("hex"),
    );
  });

  it("drops duplicate signatures and keeps first-seen order", () => {
    const account = Keypair.random();
    const [a, b] = [Keypair.random(), Keypair.random()];
    const base = unsigned(account.publicKey());
    const { client } = makeClient(() => base);

    const merged = client.mergeSignatures([sign(base, a), sign(base, b), sign(base, a), sign(base, a, b)]);

    const tx = TransactionBuilder.fromXDR(merged, Networks.TESTNET) as Transaction;
    expect(tx.signatures).toHaveLength(2);
    expect(tx.signatures[0]!.hint().equals(a.signatureHint())).toBe(true);
    expect(tx.signatures[1]!.hint().equals(b.signatureHint())).toBe(true);
  });

  it("rejects a copy of a different transaction", () => {
    const account = Keypair.random();
    const { client } = makeClient(() => "");
    const one = sign(unsigned(account.publicKey()), Keypair.random());
    const other = sign(makeEnvelope(account.publicKey(), { sequence: "101" }), Keypair.random());

    expect(() => client.mergeSignatures([one, other])).toThrow(SignedTransactionMismatchError);
  });

  it("rejects an empty list and fee-bump envelopes", () => {
    const account = Keypair.random();
    const sponsor = Keypair.random();
    const { client } = makeClient(() => "");
    const inner = TransactionBuilder.fromXDR(sign(unsigned(account.publicKey()), account), Networks.TESTNET) as Transaction;
    const bump = TransactionBuilder.buildFeeBumpTransaction(sponsor, "22468", inner, Networks.TESTNET);
    bump.sign(sponsor);

    expect(() => client.mergeSignatures([])).toThrow(RangeError);
    expect(() => client.mergeSignatures([bump.toXDR()])).toThrow(TypeError);
  });
});

describe("signAuthEntries", () => {
  it("signs only the signer's entries, changes the hash, and leaves others pending", async () => {
    const releaser = Keypair.random();
    const other = Keypair.random();
    const hot = Keypair.random();
    const base = makeEnvelope(hot.publicKey(), { authAddresses: [releaser.publicKey(), other.publicKey()] });
    const { client } = makeClient(() => base);

    const result = await client.signAuthEntries(base, releaser, { validUntilLedger: 5_000 });

    expect(result.signedEntries).toBe(1);
    const tx = TransactionBuilder.fromXDR(result.xdr, Networks.TESTNET) as Transaction;
    expect(tx.hash().toString("hex")).toBe(result.hash);
    expect(result.hash).not.toBe((TransactionBuilder.fromXDR(base, Networks.TESTNET) as Transaction).hash().toString("hex"));
    const [signedEntry, pendingEntry] = tx.operations[0]!.type === "invokeHostFunction" ? tx.operations[0]!.auth! : [];
    expect(signedEntry!.credentials().address().signatureExpirationLedger()).toBe(5_000);
    expect(signedEntry!.credentials().address().signature().switch().name).not.toBe("scvVoid");
    expect(pendingEntry!.credentials().address().signature().switch().name).toBe("scvVoid");
  });

  it("refuses an envelope that is already signed, instead of invalidating the signatures", async () => {
    const releaser = Keypair.random();
    const hot = Keypair.random();
    const base = makeEnvelope(hot.publicKey(), { authAddresses: [releaser.publicKey()] });
    const { client } = makeClient(() => base);

    await expect(client.signAuthEntries(sign(base, hot), releaser, { validUntilLedger: 5_000 })).rejects.toThrow(
      /already signed/,
    );
  });

  it("reports when the signer has no pending auth entry", async () => {
    const hot = Keypair.random();
    const base = makeEnvelope(hot.publicKey(), { authAddresses: [Keypair.random().publicKey()] });
    const { client } = makeClient(() => base);

    await expect(client.signAuthEntries(base, Keypair.random(), { validUntilLedger: 5_000 })).rejects.toThrow(
      /no unsigned auth entry/,
    );
  });

  it("defaults the expiration to about a day from the current ledger", async () => {
    const releaser = Keypair.random();
    const hot = Keypair.random();
    const base = makeEnvelope(hot.publicKey(), { authAddresses: [releaser.publicKey()] });
    const { client } = makeClient(() => base);

    const result = await client.signAuthEntries(base, releaser);

    const tx = TransactionBuilder.fromXDR(result.xdr, Networks.TESTNET) as Transaction;
    const entry = tx.operations[0]!.type === "invokeHostFunction" ? tx.operations[0]!.auth![0]! : undefined;
    expect(entry!.credentials().address().signatureExpirationLedger()).toBe(1_000 + OFFLINE_PREPARED_TX_TTL_LEDGERS);
  });
});

describe("offline multisig release, end to end (mocked network)", () => {
  it("prepares online, signs on two separate machines, merges and submits", async () => {
    const multisig = Keypair.random();
    const [signerA, signerB] = [Keypair.random(), Keypair.random()];
    const { client, rpc } = makeClient(() => makeEnvelope(multisig.publicKey()));

    // Online: prepare. Offline: each signer signs their own copy, never seeing the other's.
    const prepared = await client.prepareRelease({ escrowId: 9n, releaser: multisig.publicKey() });
    const copyA = sign(prepared.xdr, signerA);
    const copyB = sign(prepared.xdr, signerB);
    // Online again: merge and submit from anywhere.
    const merged = client.mergeSignatures([copyA, copyB]);
    const result = await client.submitSigned(merged, { expectedHash: prepared.hash });

    expect(result.txHash).toBe("outer");
    expect(result.escrowId).toBeUndefined();
    const sent = rpc.sendTransaction.mock.calls[0]![0] as Transaction;
    expect(sent.signatures).toHaveLength(2);
    expect(sent.hash().toString("hex")).toBe(prepared.hash);
  });

  it("detects that the source account moved on while the signers were offline", async () => {
    const multisig = Keypair.random();
    const { client, rpc } = makeClient(() => makeEnvelope(multisig.publicKey()));
    const prepared = await client.prepareRelease({ escrowId: 9n, releaser: multisig.publicKey() });
    const signedXdr = sign(prepared.xdr, Keypair.random(), Keypair.random());
    rpc.getAccount.mockResolvedValue({ sequenceNumber: () => "101" });

    await expect(client.submitSigned(signedXdr, { expectedHash: prepared.hash })).rejects.toBeInstanceOf(StaleSequenceError);
    expect(rpc.sendTransaction).not.toHaveBeenCalled();
  });
});

