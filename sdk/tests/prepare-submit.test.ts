import { describe, expect, it, vi } from "vitest";
import {
  Account,
  Address,
  FeeBumpTransaction,
  Keypair,
  Networks,
  Operation,
  SorobanDataBuilder,
  StrKey,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
import {
  EscrowClient,
  MaxFeeExceededError,
  PREPARED_TX_TTL_LEDGERS,
  PreparedTransactionExpiredError,
  SignedTransactionMismatchError,
  StaleSequenceError,
  UnsignedTransactionError,
} from "../src/index.js";

const CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 7));

/** A real unsigned Soroban-shaped transaction targeting the escrow contract. */
function makeEnvelope(
  source: string,
  options: { sequence?: string; authAddress?: string; fn?: string } = {},
): string {
  const auth = options.authAddress
    ? [
        new xdr.SorobanAuthorizationEntry({
          credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
            new xdr.SorobanAddressCredentials({
              address: new Address(options.authAddress).toScAddress(),
              nonce: xdr.Int64.fromString("5"),
              signatureExpirationLedger: 0,
              signature: xdr.ScVal.scvVoid(),
            }),
          ),
          rootInvocation: new xdr.SorobanAuthorizedInvocation({
            function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
              new xdr.InvokeContractArgs({
                contractAddress: new Address(CONTRACT_ID).toScAddress(),
                functionName: options.fn ?? "create_escrow",
                args: [],
              }),
            ),
            subInvocations: [],
          }),
        }),
      ]
    : [];
  return new TransactionBuilder(new Account(source, options.sequence ?? "100"), {
    fee: "10000",
    networkPassphrase: Networks.TESTNET,
    timebounds: { minTime: 0, maxTime: Math.floor(Date.now() / 1000) + 300 },
    sorobanData: new SorobanDataBuilder().setResourceFee(1234).build(),
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: CONTRACT_ID,
        function: options.fn ?? "create_escrow",
        args: [],
        auth,
      }),
    )
    .build()
    .toXDR();
}

function signed(envelopeXdr: string, ...signers: Keypair[]): string {
  const tx = TransactionBuilder.fromXDR(envelopeXdr, Networks.TESTNET) as Transaction;
  for (const signer of signers) tx.sign(signer);
  return tx.toXDR();
}

type Fakes = {
  latestLedger?: number;
  onChainSequence?: string;
  send?: Record<string, unknown>;
  poll?: Record<string, unknown>;
  assembled?: unknown;
};

function makeClient(fakes: Fakes = {}) {
  const sendTransaction = vi.fn(async () => fakes.send ?? { status: "PENDING", hash: "outerhash" });
  const pollTransaction = vi.fn(
    async () => fakes.poll ?? { status: "SUCCESS", returnValue: nativeToScVal(42n, { type: "u64" }) },
  );
  const getAccount = vi.fn(async () => ({ sequenceNumber: () => fakes.onChainSequence ?? "100" }));
  const getLatestLedger = vi.fn(async () => ({ sequence: fakes.latestLedger ?? 500 }));
  const createEscrow = vi.fn(async () => fakes.assembled);
  const createEscrowReleaseTime = vi.fn(async () => fakes.assembled);
  const client = Object.assign(new EscrowClient({ contractId: CONTRACT_ID, rpcUrl: "https://127.0.0.1:1" }), {
    rpc: { sendTransaction, pollTransaction, getAccount, getLatestLedger },
    publicContractClient: () => ({
      create_escrow: createEscrow,
      create_escrow_release_time: createEscrowReleaseTime,
    }),
  });
  return { client, sendTransaction, pollTransaction, getAccount, getLatestLedger, createEscrow, createEscrowReleaseTime };
}

const baseParams = (payer: string) => ({
  payer,
  payee: Keypair.random().publicKey(),
  token: StrKey.encodeContract(Buffer.alloc(32, 9)),
  amount: 1_000n,
  conditionRef: "order-1",
  releaser: Keypair.random().publicKey(),
});

describe("prepareCreateEscrow", () => {
  it("returns an unsigned envelope bounded to a ledger window, keeping the Soroban data", async () => {
    const payer = Keypair.random();
    const envelope = makeEnvelope(payer.publicKey());
    const { client, createEscrow } = makeClient({ latestLedger: 500, assembled: { isReadCall: false, toXDR: () => envelope } });

    const prepared = await client.prepareCreateEscrow(baseParams(payer.publicKey()));

    expect(prepared.validUntilLedger).toBe(500 + PREPARED_TX_TTL_LEDGERS);
    expect(prepared.source).toBe(payer.publicKey());
    expect(prepared.authSigners).toEqual([]);
    const tx = TransactionBuilder.fromXDR(prepared.xdr, Networks.TESTNET) as Transaction;
    expect(tx.ledgerBounds).toEqual({ minLedger: 0, maxLedger: 620 });
    expect(tx.timeBounds).toBeUndefined();
    expect(tx.signatures).toHaveLength(0);
    expect(tx.hash().toString("hex")).toBe(prepared.hash);
    // Resource data and fee survive the precondition change.
    expect(tx.toEnvelope().v1().tx().ext().sorobanData().resourceFee().toString()).toBe("1234");
    expect(tx.fee).toBe("11234");
    expect(createEscrow).toHaveBeenCalledWith(expect.objectContaining({ payer: payer.publicKey(), condition_ref: "order-1" }));
  });

  it("lists the payer as an auth signer when another account is the source", async () => {
    const payer = Keypair.random();
    const backend = Keypair.random();
    const envelope = makeEnvelope(backend.publicKey(), { authAddress: payer.publicKey() });
    const { client } = makeClient({ assembled: { isReadCall: false, toXDR: () => envelope } });

    const prepared = await client.prepareCreateEscrow({ ...baseParams(payer.publicKey()), source: backend.publicKey(), authValidForLedgers: 50 });

    expect(prepared.source).toBe(backend.publicKey());
    expect(prepared.authSigners).toEqual([payer.publicKey()]);
    expect(prepared.authValidUntilLedger).toBe(550);
  });

  it("does not list the source itself as an auth signer", async () => {
    const payer = Keypair.random();
    const envelope = makeEnvelope(payer.publicKey(), { authAddress: payer.publicKey() });
    const { client } = makeClient({ assembled: { isReadCall: false, toXDR: () => envelope } });

    expect((await client.prepareCreateEscrow(baseParams(payer.publicKey()))).authSigners).toEqual([]);
  });

  it("uses create_escrow_release_time when releaseNotBefore is set", async () => {
    const payer = Keypair.random();
    const envelope = makeEnvelope(payer.publicKey());
    const fakes = makeClient({ assembled: { isReadCall: false, toXDR: () => envelope } });

    await fakes.client.prepareCreateEscrow({ ...baseParams(payer.publicKey()), releaseNotBefore: 2_000n });

    expect(fakes.createEscrowReleaseTime).toHaveBeenCalledWith(expect.objectContaining({ release_not_before: 2_000n }));
    expect(fakes.createEscrow).not.toHaveBeenCalled();
  });

  it("rejects an over-long conditionRef and a bad window before touching the network", async () => {
    const payer = Keypair.random();
    const fakes = makeClient({ assembled: { isReadCall: false, toXDR: () => makeEnvelope(payer.publicKey()) } });

    await expect(
      fakes.client.prepareCreateEscrow({ ...baseParams(payer.publicKey()), conditionRef: "x".repeat(65) }),
    ).rejects.toThrow(/conditionRef must be at most/);
    await expect(
      fakes.client.prepareCreateEscrow({ ...baseParams(payer.publicKey()), validForLedgers: 0 }),
    ).rejects.toThrow(RangeError);
    expect(fakes.createEscrow).not.toHaveBeenCalled();
  });

  it("refuses a read-only simulation", async () => {
    const payer = Keypair.random();
    const { client } = makeClient({ assembled: { isReadCall: true } });

    await expect(client.prepareCreateEscrow(baseParams(payer.publicKey()))).rejects.toThrow(/read call/);
  });
});

describe("submitSigned", () => {
  async function preparedAndSigned(options: { latestLedger?: number } = {}) {
    const payer = Keypair.random();
    const fakes = makeClient({
      latestLedger: options.latestLedger ?? 500,
      assembled: { isReadCall: false, toXDR: () => makeEnvelope(payer.publicKey()) },
    });
    const prepared = await fakes.client.prepareCreateEscrow(baseParams(payer.publicKey()));
    return { ...fakes, payer, prepared, signedXdr: signed(prepared.xdr, payer) };
  }

  it("submits, polls to completion and returns the new escrow id", async () => {
    const { client, sendTransaction, pollTransaction, prepared, signedXdr } = await preparedAndSigned();

    const result = await client.submitSigned(signedXdr, { expectedHash: prepared.hash });

    expect(result).toEqual({ txHash: "outerhash", innerTxHash: prepared.hash, escrowId: 42n });
    expect(sendTransaction).toHaveBeenCalledTimes(1);
    expect(sendTransaction.mock.calls[0]![0]).toBeInstanceOf(Transaction);
    expect(pollTransaction).toHaveBeenCalledWith("outerhash", { attempts: 30 });
  });

  it("returns no escrow id for a transaction that returns nothing", async () => {
    const { client, signedXdr } = await preparedAndSigned();
    const { client: other } = makeClient({ poll: { status: "SUCCESS", returnValue: xdr.ScVal.scvVoid() } });
    (client as unknown as { rpc: unknown }).rpc = (other as unknown as { rpc: unknown }).rpc;

    const result = await client.submitSigned(signedXdr);

    expect(result.escrowId).toBeUndefined();
  });

  it("rejects a signed envelope whose hash is not the prepared one, without sending", async () => {
    const { client, sendTransaction, payer, prepared } = await preparedAndSigned();
    const different = signed(makeEnvelope(payer.publicKey(), { sequence: "100", fn: "release" }), payer);

    await expect(client.submitSigned(different, { expectedHash: prepared.hash })).rejects.toBeInstanceOf(
      SignedTransactionMismatchError,
    );
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("rejects an unsigned envelope", async () => {
    const { client, sendTransaction, prepared } = await preparedAndSigned();

    await expect(client.submitSigned(prepared.xdr)).rejects.toBeInstanceOf(UnsignedTransactionError);
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("throws a typed error when the ledger window has passed, without sending", async () => {
    const { client, sendTransaction, signedXdr } = await preparedAndSigned();
    (client as unknown as { rpc: { getLatestLedger: unknown } }).rpc.getLatestLedger = async () => ({ sequence: 621 });

    const error = await client.submitSigned(signedXdr).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PreparedTransactionExpiredError);
    expect(error).toMatchObject({ validUntilLedger: 620, currentLedger: 621 });
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("is still valid on its last ledger", async () => {
    const { client, signedXdr } = await preparedAndSigned();
    (client as unknown as { rpc: { getLatestLedger: unknown } }).rpc.getLatestLedger = async () => ({ sequence: 620 });

    await expect(client.submitSigned(signedXdr)).resolves.toMatchObject({ escrowId: 42n });
  });

  it("detects a moved source sequence before sending", async () => {
    const { client, sendTransaction, getAccount, signedXdr } = await preparedAndSigned();
    getAccount.mockResolvedValue({ sequenceNumber: () => "105" });

    const error = await client.submitSigned(signedXdr).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(StaleSequenceError);
    expect(error).toMatchObject({ expectedSequence: 100n, onChainSequence: 105n });
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("maps tx_too_late and tx_bad_seq rejections to the typed errors", async () => {
    for (const [name, expected] of [
      ["txTooLate", PreparedTransactionExpiredError],
      ["txBadSeq", StaleSequenceError],
    ] as const) {
      const { client, sendTransaction, signedXdr } = await preparedAndSigned();
      sendTransaction.mockResolvedValue({
        status: "ERROR",
        hash: "h",
        errorResult: { result: () => ({ switch: () => ({ name }) }) },
      });
      await expect(client.submitSigned(signedXdr)).rejects.toBeInstanceOf(expected);
    }
  });

  it("reports other rejections, failures and unconfirmed transactions plainly", async () => {
    const rejected = await preparedAndSigned();
    rejected.sendTransaction.mockResolvedValue({ status: "ERROR", hash: "h1", errorResult: undefined });
    await expect(rejected.client.submitSigned(rejected.signedXdr)).rejects.toThrow(/h1 was rejected/);

    const failed = await preparedAndSigned();
    failed.pollTransaction.mockResolvedValue({ status: "FAILED" });
    await expect(failed.client.submitSigned(failed.signedXdr)).rejects.toThrow(/failed on-chain/);

    const pending = await preparedAndSigned();
    pending.pollTransaction.mockResolvedValue({ status: "NOT_FOUND" });
    await expect(pending.client.submitSigned(pending.signedXdr, { pollAttempts: 3 })).rejects.toThrow(
      /not confirmed after 3 polls/,
    );
  });

  it("wraps the transaction in a capped fee-bump when given a feeBumpSigner", async () => {
    const { client, sendTransaction, prepared, signedXdr } = await preparedAndSigned();
    const sponsor = Keypair.random();

    const result = await client.submitSigned(signedXdr, { feeBumpSigner: sponsor, maxFee: 100_000n });

    const sentTx = sendTransaction.mock.calls[0]![0];
    expect(sentTx).toBeInstanceOf(FeeBumpTransaction);
    const bump = sentTx as FeeBumpTransaction;
    expect(bump.innerTransaction.hash().toString("hex")).toBe(prepared.hash);
    // Base fee defaults to the inner fee rate (a Soroban fee includes its
    // resource fee), not the network minimum, which the network would reject.
    // The resource fee (1,234) is charged on top: 11,234 x 2 + 1,234.
    expect(bump.fee).toBe("23702");
    expect(result.innerTxHash).toBe(prepared.hash);
  });

  it("never exceeds the fee-bump cap, including the resource fee", async () => {
    const { client, sendTransaction, signedXdr } = await preparedAndSigned();

    // 22,468 would pass a base-fee-only check; the charged fee is 23,702.
    for (const maxFee of [1_000n, 23_000n]) {
      await expect(client.submitSigned(signedXdr, { feeBumpSigner: Keypair.random(), maxFee })).rejects.toBeInstanceOf(
        MaxFeeExceededError,
      );
    }
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("refuses to sponsor a transaction that touches another contract", async () => {
    const payer = Keypair.random();
    const { client, sendTransaction } = makeClient();
    const foreign = new TransactionBuilder(new Account(payer.publicKey(), "100"), {
      fee: "10000",
      networkPassphrase: Networks.TESTNET,
      timebounds: { minTime: 0, maxTime: 0 },
    })
      .addOperation(
        Operation.invokeContractFunction({ contract: StrKey.encodeContract(Buffer.alloc(32, 1)), function: "x", args: [] }),
      )
      .build();
    foreign.sign(payer);

    await expect(client.submitSigned(foreign.toXDR(), { feeBumpSigner: Keypair.random() })).rejects.toThrow();
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("rejects an already fee-bumped envelope", async () => {
    const { client, signedXdr } = await preparedAndSigned();
    const sponsor = Keypair.random();
    const inner = TransactionBuilder.fromXDR(signedXdr, Networks.TESTNET) as Transaction;
    const bump = TransactionBuilder.buildFeeBumpTransaction(sponsor, "22468", inner, Networks.TESTNET);
    bump.sign(sponsor);

    await expect(client.submitSigned(bump.toXDR())).rejects.toThrow(TypeError);
  });
});
