// Offline tests for two-party releaser rotation (issue #326): prepare →
// each party signs only its own auth entry → a third account submits.
// Simulation is mocked; the signing and merging run on real envelopes.
import {
  Account,
  Address,
  BASE_FEE,
  Keypair,
  Operation,
  SorobanDataBuilder,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";

import {
  AuthorizationExpiredError,
  EscrowClient,
  ROTATION_AUTH_TTL_LEDGERS,
  RotationAuthorizationError,
  RotationPreconditionError,
  mergeRotationAuthorizations,
  type Escrow,
  type RotationAuthorization,
} from "../src/index.js";

const CONTRACT = "CB7WHNBNHEVPFTGDOWHFMDOWKLTA2Z4CBR3KZGYIVSSJNUT3OGWYSW2H";
const OTHER_CONTRACT = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const PASSPHRASE = "Test SDF Network ; September 2015";

const releaser = Keypair.random();
const payer = Keypair.random();
const payee = Keypair.random();
const submitter = Keypair.random();
const newReleaser = Keypair.random().publicKey();

function makeClient(fakes: Record<string, unknown> = {}, ledger = 100): EscrowClient {
  return Object.assign(
    new EscrowClient({ contractId: CONTRACT, rpcUrl: "https://127.0.0.1:1", networkPassphrase: PASSPHRASE }),
    {
      ensureNetworkVerified: async () => {},
      rpc: { getLatestLedger: async () => ({ sequence: ledger }) },
    },
    fakes,
  );
}

function escrow(overrides: Partial<Escrow> = {}): Escrow {
  return {
    payer: payer.publicKey(),
    payee: payee.publicKey(),
    token: OTHER_CONTRACT,
    amount: 100n,
    conditionRef: "ref",
    releasers: [releaser.publicKey()],
    threshold: 1,
    status: "Funded",
    ...overrides,
  } as Escrow;
}

function rotationArgs(target = newReleaser): xdr.ScVal[] {
  return [
    nativeToScVal(7n, { type: "u64" }),
    new Address(releaser.publicKey()).toScVal(),
    new Address(target).toScVal(),
  ];
}

function authEntry(
  address: string,
  { fn = "rotate_releaser", contract = CONTRACT, sub = [] as xdr.SorobanAuthorizedInvocation[], nonce = "1" } = {},
): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(address).toScAddress(),
        nonce: xdr.Int64.fromString(nonce),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(contract).toScAddress(),
          functionName: fn,
          args: fn === "rotate_releaser" ? rotationArgs() : [],
        }),
      ),
      subInvocations: sub,
    }),
  });
}

/** A simulated rotate_releaser, as `AssembledTransaction.toJSON()` would serialize it. */
function simulatedRotation(auth: xdr.SorobanAuthorizationEntry[], target = newReleaser): string {
  const tx = new TransactionBuilder(new Account(submitter.publicKey(), "41"), {
    fee: BASE_FEE,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(
      Operation.invokeContractFunction({ contract: CONTRACT, function: "rotate_releaser", args: rotationArgs(target), auth }),
    )
    .setTimeout(300)
    .build();
  return JSON.stringify({
    method: "rotate_releaser",
    tx: tx.toXDR(),
    simulationResult: { auth: auth.map((a) => a.toXDR("base64")), retval: xdr.ScVal.scvVoid().toXDR("base64") },
    simulationTransactionData: new SorobanDataBuilder().build().toXDR("base64"),
  });
}

function prepared(auth = [authEntry(releaser.publicKey()), authEntry(payer.publicKey(), { nonce: "2" })], expiresAtLedger = 500): RotationAuthorization {
  return { transaction: simulatedRotation(auth), expiresAtLedger, pendingSigners: [] };
}

function signedEntries(transaction: string): xdr.SorobanAuthorizationEntry[] {
  const env = xdr.TransactionEnvelope.fromXDR(JSON.parse(transaction).tx, "base64");
  return env.v1().tx().operations()[0]!.body().invokeHostFunctionOp().auth()
    .filter((entry) => entry.credentials().address().signature().switch() !== xdr.ScValType.scvVoid());
}

describe("prepareRotateReleaser", () => {
  it("simulates rotate_releaser from the submitter and lists both parties' entries", async () => {
    const rotate = vi.fn(async () => ({
      isReadCall: false,
      toJSON: () => JSON.stringify({ method: "rotate_releaser" }),
      needsNonInvokerSigningBy: () => [releaser.publicKey(), payer.publicKey()],
    }));
    const publicContractClient = vi.fn(() => ({ rotate_releaser: rotate }));
    const client = makeClient({ getEscrow: async () => escrow(), publicContractClient }, 1000);

    const rotation = await client.prepareRotateReleaser({ escrowId: 7n, newReleaser, source: submitter.publicKey() });

    expect(publicContractClient).toHaveBeenCalledWith(submitter.publicKey());
    expect(rotate).toHaveBeenCalledWith({ escrow_id: 7n, caller: releaser.publicKey(), new_releaser: newReleaser });
    expect(rotation.expiresAtLedger).toBe(1000 + ROTATION_AUTH_TTL_LEDGERS);
    expect(rotation.pendingSigners).toEqual([releaser.publicKey(), payer.publicKey()]);
  });

  it("needs a single entry when the payer is also the releaser", async () => {
    const client = makeClient({
      getEscrow: async () => escrow({ payer: releaser.publicKey() }),
      publicContractClient: () => ({
        rotate_releaser: async () => ({
          isReadCall: false,
          toJSON: () => "{}",
          needsNonInvokerSigningBy: () => [releaser.publicKey()],
        }),
      }),
    });
    const rotation = await client.prepareRotateReleaser({ escrowId: 7n, newReleaser, source: submitter.publicKey(), authValidForLedgers: 5 });
    expect(rotation.pendingSigners).toEqual([releaser.publicKey()]);
    expect(rotation.expiresAtLedger).toBe(105);
  });

  it.each([
    ["NotFunded", escrow({ status: "Released" }), newReleaser],
    ["NotSingleReleaser", escrow({ releasers: [releaser.publicKey(), payer.publicKey()], threshold: 2 }), newReleaser],
    ["NewReleaserIsPayee", escrow(), payee.publicKey()],
    ["NewReleaserIsContract", escrow(), CONTRACT],
    ["NewReleaserUnchanged", escrow(), releaser.publicKey()],
  ] as const)("refuses %s before simulating", async (code, record, target) => {
    const publicContractClient = vi.fn();
    const client = makeClient({ getEscrow: async () => record, publicContractClient });
    const attempt = client.prepareRotateReleaser({ escrowId: 7n, newReleaser: target, source: submitter.publicKey() });
    await expect(attempt).rejects.toBeInstanceOf(RotationPreconditionError);
    await expect(attempt).rejects.toMatchObject({ code });
    expect(publicContractClient).not.toHaveBeenCalled();
  });
});

describe("signRotationAuth", () => {
  it("signs only the signer's own entry, leaving the other party and the envelope unsigned", async () => {
    const client = makeClient();
    const rotation = await client.signRotationAuth(prepared(), releaser);

    expect(rotation.pendingSigners).toEqual([payer.publicKey()]);
    const signed = signedEntries(rotation.transaction);
    expect(signed).toHaveLength(1);
    const credentials = signed[0]!.credentials().address();
    expect(Address.fromScAddress(credentials.address()).toString()).toBe(releaser.publicKey());
    expect(credentials.signatureExpirationLedger()).toBe(500);
    const env = xdr.TransactionEnvelope.fromXDR(JSON.parse(rotation.transaction).tx, "base64");
    expect(env.v1().signatures()).toHaveLength(0);
  });

  it("refuses an entry that authorizes anything but rotate_releaser on this contract", async () => {
    const client = makeClient();
    for (const auth of [
      [authEntry(releaser.publicKey(), { fn: "release" })],
      [authEntry(releaser.publicKey(), { contract: OTHER_CONTRACT })],
      [authEntry(releaser.publicKey(), {
        sub: [authEntry(releaser.publicKey(), { fn: "transfer", contract: OTHER_CONTRACT }).rootInvocation()],
      })],
    ]) {
      await expect(client.signRotationAuth(prepared(auth), releaser)).rejects.toBeInstanceOf(RotationAuthorizationError);
    }
  });

  it("refuses a signer that has no entry in the rotation", async () => {
    await expect(makeClient().signRotationAuth(prepared(), Keypair.random())).rejects.toThrow(/no unsigned auth entry/);
  });

  it("refuses to sign once the expiration ledger has passed", async () => {
    await expect(makeClient({}, 501).signRotationAuth(prepared(), releaser)).rejects.toBeInstanceOf(AuthorizationExpiredError);
  });

  it("rejects an authorization for another method", async () => {
    const other = { ...prepared(), transaction: JSON.stringify({ method: "release", tx: "x" }) };
    await expect(makeClient().signRotationAuth(other, releaser)).rejects.toThrow(/not rotate_releaser/);
  });
});

describe("submitRotation", () => {
  it("merges independently signed copies so both entries are signed", async () => {
    const client = makeClient();
    const base = prepared();
    const [byReleaser, byPayer] = await Promise.all([
      client.signRotationAuth(base, releaser),
      client.signRotationAuth(base, payer),
    ]);
    const merged = mergeRotationAuthorizations([byReleaser, byPayer]);
    const addresses = signedEntries(merged).map((e) => Address.fromScAddress(e.credentials().address().address()).toString());
    expect(addresses.sort()).toEqual([releaser.publicKey(), payer.publicKey()].sort());
  });

  it("signs the envelope as the submitter and sends once", async () => {
    const signAndSend = vi.fn(async () => ({ result: { unwrap: () => undefined }, sendTransactionResponse: { hash: "rot456" } }));
    const txFromJSON = vi.fn(() => ({ needsNonInvokerSigningBy: () => [], signAndSend }));
    const contractClient = vi.fn(() => ({ txFromJSON }));
    const signer = makeClient();
    const base = prepared();
    const copies = [await signer.signRotationAuth(base, releaser), await signer.signRotationAuth(base, payer)];

    const result = await makeClient({ contractClient }).submitRotation(copies, submitter);

    expect(result.txHash).toBe("rot456");
    expect(contractClient).toHaveBeenCalledWith(submitter);
    expect(signedEntries(txFromJSON.mock.calls[0]![0] as string)).toHaveLength(2);
    expect(signAndSend).toHaveBeenCalledTimes(1);
  });

  it("refuses while a party's entry is still unsigned", async () => {
    const client = makeClient();
    const onlyReleaser = await client.signRotationAuth(prepared(), releaser);
    await expect(client.submitRotation(onlyReleaser, submitter)).rejects.toThrow(new RegExp(payer.publicKey()));
  });

  it("detects expired auth before submitting", async () => {
    const contractClient = vi.fn();
    const client = makeClient({ contractClient }, 1000);
    await expect(client.submitRotation(prepared(undefined, 999), submitter)).rejects.toBeInstanceOf(AuthorizationExpiredError);
    expect(contractClient).not.toHaveBeenCalled();
  });

  it("refuses copies that are not the same transaction", async () => {
    const a = prepared();
    const b = { ...a, transaction: simulatedRotation([authEntry(releaser.publicKey()), authEntry(payer.publicKey(), { nonce: "2" })], Keypair.random().publicKey()) };
    expect(() => mergeRotationAuthorizations([a, b])).toThrow(/not the same transaction/);
  });
});
