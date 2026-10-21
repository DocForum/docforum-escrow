// Fast, offline tests for the fee-estimation, fee-bump and sponsorship-guard
// helpers (issue #70). Everything here builds real transaction envelopes and
// signs them with throwaway keypairs — no RPC, no network, no fixtures on disk.
//
// The one testnet integration case lives in `testnet-integration.test.ts`,
// which is deliberately not wired into CI.
import {
  Account,
  Address,
  Asset,
  BASE_FEE,
  Keypair,
  Operation,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import {
  computeFeeEstimate,
  EscrowClient,
  MaxFeeExceededError,
  SponsorshipGuardError,
} from "../src/index.js";

const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
// Public testnet addresses used elsewhere in this repo's tests.
const ESCROW_CONTRACT = "CAFI5QOTNLK5OIHEHGGQ7B22RN5IUOFGKKEID2OQCZSCJAQS4FLSS2DR";
const NATIVE_XLM_SAC = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

function client(): EscrowClient {
  return new EscrowClient({ contractId: ESCROW_CONTRACT, networkPassphrase: NETWORK_PASSPHRASE });
}

function sdkAccount(): Account {
  return new Account(Keypair.random().publicKey(), "1");
}

function sign(transaction: ReturnType<TransactionBuilder["build"]>, signer: Keypair): string {
  transaction.sign(signer);
  return transaction.toXDR();
}

/** A signed envelope invoking `contract`'s `release`. */
function invokeRelease(contract = ESCROW_CONTRACT, auth: xdr.SorobanAuthorizationEntry[] = []): string {
  const signer = Keypair.random();
  const transaction = new TransactionBuilder(sdkAccount(), {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract,
        function: "release",
        args: [],
        auth,
      }),
    )
    .setTimeout(30)
    .build();
  return sign(transaction, signer);
}

/** A contract-address auth entry, as a malicious invocation would carry. */
function contractAuthEntry(contract: string): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(contract).toScAddress(),
        nonce: xdr.Int64.fromString("1"),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(contract).toScAddress(),
          functionName: "transfer",
          args: [],
        }),
      ),
      subInvocations: [],
    }),
  });
}

describe("computeFeeEstimate", () => {
  it("adds a 20% buffer to the resource fee by default, rounding up", () => {
    const estimate = computeFeeEstimate({ minResourceFee: 1_000n, inclusionFee: 200n });
    expect(estimate.minResourceFee).toBe(1_000n);
    expect(estimate.resourceFee).toBe(1_200n);
    expect(estimate.total).toBe(1_400n);
  });

  it("rounds the buffered resource fee up, never down", () => {
    // 333 × 1.2 = 399.6 → 400, so the estimate cannot come out a strop short.
    expect(computeFeeEstimate({ minResourceFee: 333n, inclusionFee: 0n }).resourceFee).toBe(400n);
  });

  it("honours a caller-supplied buffer of zero", () => {
    const estimate = computeFeeEstimate({ minResourceFee: 1_000n, inclusionFee: 100n, bufferBps: 0 });
    expect(estimate.resourceFee).toBe(1_000n);
    expect(estimate.total).toBe(1_100n);
  });

  it("rejects invalid input rather than returning a nonsense estimate", () => {
    expect(() => computeFeeEstimate({ minResourceFee: -1n, inclusionFee: 0n })).toThrow(RangeError);
    expect(() => computeFeeEstimate({ minResourceFee: 0n, inclusionFee: -1n })).toThrow(RangeError);
    expect(() => computeFeeEstimate({ minResourceFee: 0n, inclusionFee: 0n, bufferBps: -1 })).toThrow(RangeError);
    expect(() => computeFeeEstimate({ minResourceFee: 0n, inclusionFee: 0n, bufferBps: 1.5 })).toThrow(RangeError);
  });
});

describe("feeBump", () => {
  it("pays baseFee × (inner operations + 1) and returns the inner hash", () => {
    const signed = invokeRelease();
    const sponsor = Keypair.random();
    const inner = TransactionBuilder.fromXDR(signed, NETWORK_PASSPHRASE);

    const result = client().feeBump(signed, sponsor, { maxFee: 1_000n, baseFee: 100n });

    expect(result.fee).toBe(200n); // 1 inner op + the wrapping bump op
    expect(result.innerTxHash).toBe(inner.hash().toString("hex"));

    const envelope = TransactionBuilder.fromXDR(result.xdr, NETWORK_PASSPHRASE);
    expect(envelope.fee).toBe("200");
    expect(envelope.toXDR()).toBe(result.xdr);
  });

  it("uses the network base fee when no baseFee is given", () => {
    const result = client().feeBump(invokeRelease(), Keypair.random(), { maxFee: 1_000n });
    expect(result.fee).toBe(BigInt(BASE_FEE) * 2n);
  });

  it("throws MaxFeeExceededError instead of silently overshooting the cap", () => {
    const sponsor = Keypair.random();
    const signed = invokeRelease();

    expect(() => client().feeBump(signed, sponsor, { maxFee: 199n, baseFee: 100n })).toThrow(
      MaxFeeExceededError,
    );
    try {
      client().feeBump(signed, sponsor, { maxFee: 199n, baseFee: 100n });
    } catch (error) {
      const exceeded = error as MaxFeeExceededError;
      expect(exceeded.requestedFee).toBe(200n);
      expect(exceeded.maxFee).toBe(199n);
    }
  });

  it("refuses to bump an envelope that is already a fee-bump", () => {
    const first = client().feeBump(invokeRelease(), Keypair.random(), { maxFee: 1_000n });
    expect(() => client().feeBump(first.xdr, Keypair.random(), { maxFee: 1_000n })).toThrow(TypeError);
  });

  it("rejects a nonsensical base fee", () => {
    expect(() => client().feeBump(invokeRelease(), Keypair.random(), { maxFee: 1_000n, baseFee: 0n })).toThrow(
      RangeError,
    );
  });
});

describe("guardSponsorship", () => {
  it("accepts an invocation of the escrow contract", () => {
    const result = client().guardSponsorship(invokeRelease());
    expect(result.ok).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.invokedContracts).toEqual([ESCROW_CONTRACT]);
  });

  it("rejects any non-invocation operation in the envelope", () => {
    // The reviewer's case: a contract call with an extra payment smuggled in.
    const signer = Keypair.random();
    const transaction = new TransactionBuilder(sdkAccount(), {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        Operation.invokeContractFunction({ contract: ESCROW_CONTRACT, function: "release", args: [] }),
      )
      .addOperation(
        Operation.payment({
          destination: Keypair.random().publicKey(),
          asset: Asset.native(),
          amount: "1",
        }),
      )
      .setTimeout(30)
      .build();

    const result = client().guardSponsorship(sign(transaction, signer));
    expect(result.ok).toBe(false);
    expect(result.reasons).toEqual([`operation type "payment" is not a contract invocation`]);
  });

  it("rejects an invocation of a foreign contract", () => {
    const result = client().guardSponsorship(invokeRelease(NATIVE_XLM_SAC));
    expect(result.ok).toBe(false);
    expect(result.reasons).toEqual([`operation invokes foreign contract ${NATIVE_XLM_SAC}`]);
    expect(result.invokedContracts).toEqual([NATIVE_XLM_SAC]);
  });

  it("inspects contract-address auth entries, not just operations", () => {
    const result = client().guardSponsorship(invokeRelease(ESCROW_CONTRACT, [contractAuthEntry(NATIVE_XLM_SAC)]));
    expect(result.ok).toBe(false);
    expect(result.reasons).toEqual([`auth entry targets foreign contract ${NATIVE_XLM_SAC}`]);
  });

  it("allows account-address auth entries (the payer/releaser signatures)", () => {
    const signer = Keypair.random();
    const entry = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: new Address(signer.publicKey()).toScAddress(),
          nonce: xdr.Int64.fromString("1"),
          signatureExpirationLedger: 0,
          signature: xdr.ScVal.scvVoid(),
        }),
      ),
      rootInvocation: new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
          new xdr.InvokeContractArgs({
            contractAddress: new Address(ESCROW_CONTRACT).toScAddress(),
            functionName: "release",
            args: [],
          }),
        ),
        subInvocations: [],
      }),
    });

    const result = client().guardSponsorship(invokeRelease(ESCROW_CONTRACT, [entry]));
    expect(result.ok).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("unwraps a fee-bump envelope but still refuses to sponsor it twice", () => {
    const bumped = client().feeBump(invokeRelease(), Keypair.random(), { maxFee: 1_000n });
    const result = client().guardSponsorship(bumped.xdr);
    expect(result.ok).toBe(false);
    expect(result.reasons).toEqual(["envelope is already a fee-bump transaction"]);
    expect(result.invokedContracts).toEqual([ESCROW_CONTRACT]);
  });

  it("reports undecodable XDR instead of throwing", () => {
    const result = client().guardSponsorship("not-xdr");
    expect(result.ok).toBe(false);
    expect(result.reasons[0]).toMatch(/could not decode transaction envelope/);
  });

  it("assertSponsorable throws the guard reasons", () => {
    expect(() => client().assertSponsorable(invokeRelease(NATIVE_XLM_SAC))).toThrow(SponsorshipGuardError);
  });
});
