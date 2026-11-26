import { describe, expect, it, vi } from "vitest";
import { Address, Keypair, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { ArchivedEntryError, EscrowClient } from "../src/index.js";
import { decodeEscrowDataFromScVal, escrowDataKey, escrowLedgerKey } from "../src/escrow-data.js";

function field(name: string, value: xdr.ScVal): xdr.ScMapEntry {
  return new xdr.ScMapEntry({
    key: xdr.ScVal.scvSymbol(name),
    val: value,
  });
}

function legacyEscrowRecord() {
  const payer = Keypair.random().publicKey();
  const payee = Keypair.random().publicKey();
  const token = Keypair.random().publicKey();
  const releaser = Keypair.random().publicKey();
  // The 2026-10-20 testnet deployment predates `release_not_before`; its
  // get_escrow result is this map, with no field for it.
  const record = xdr.ScVal.scvMap([
    field("accepted_at", xdr.ScVal.scvVoid()),
    field("amount", nativeToScVal(1_000_000n, { type: "i128" })),
    field("condition_ref", nativeToScVal("legacy-layout", { type: "string" })),
    field("notify_payee", nativeToScVal(false, { type: "bool" })),
    field("payee", new Address(payee).toScVal()),
    field("payer", new Address(payer).toScVal()),
    field("refund_after", xdr.ScVal.scvVoid()),
    field("refund_to", new Address(payer).toScVal()),
    field("releasers", xdr.ScVal.scvVec([new Address(releaser).toScVal()])),
    field("requires_acceptance", nativeToScVal(false, { type: "bool" })),
    field("status", xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Released")])),
    field("threshold", nativeToScVal(1, { type: "u32" })),
    field("token", new Address(token).toScVal()),
  ]);
  return { record, payer, payee, token, releaser };
}

describe("get_escrow cross-version decoding", () => {
  it("decodes a deployment that predates release_not_before by field name", () => {
    const { record, payer, payee, token, releaser } = legacyEscrowRecord();

    const escrow = decodeEscrowDataFromScVal(record);

    expect(escrow.payer).toBe(payer);
    expect(escrow.payee).toBe(payee);
    expect(escrow.token).toBe(token);
    expect(escrow.amount).toBe(1_000_000n);
    expect(escrow.conditionRef).toBe("legacy-layout");
    expect(escrow.releasers).toEqual([releaser]);
    expect(escrow.threshold).toBe(1);
    expect(escrow.refundAfter).toBeUndefined();
    expect(escrow.releaseNotBefore).toBeUndefined();
    expect(escrow.notifyPayee).toBe(false);
    expect(escrow.refundTo).toBe(payer);
    expect(escrow.requiresAcceptance).toBe(false);
    expect(escrow.acceptedAt).toBeUndefined();
    expect(escrow.status).toBe("Released");
  });

  it("decodes acceptance fields, and defaults them on records that predate the gate", () => {
    const { record } = legacyEscrowRecord();
    const entries = record.map()!.map((entry) => {
      const key = entry.key().sym().toString();
      if (key === "accepted_at") return field(key, nativeToScVal(1_700_000_000n, { type: "u64" }));
      if (key === "requires_acceptance") return field(key, nativeToScVal(true, { type: "bool" }));
      return entry;
    });
    const accepted = decodeEscrowDataFromScVal(xdr.ScVal.scvMap(entries));
    expect(accepted.requiresAcceptance).toBe(true);
    expect(accepted.acceptedAt).toBe(1_700_000_000n);

    const withoutGate = xdr.ScVal.scvMap(
      record.map()!.filter((entry) => !["accepted_at", "requires_acceptance"].includes(entry.key().sym().toString())),
    );
    const legacy = decodeEscrowDataFromScVal(withoutGate);
    expect(legacy.requiresAcceptance).toBe(false);
    expect(legacy.acceptedAt).toBeUndefined();
  });

  it("falls back to name-based decoding when the generated spec mis-aligns a legacy record", async () => {
    const { record, payer } = legacyEscrowRecord();
    const layoutError = new TypeError(
      "Type [object Object] was not vec, but [object Object] is"
    );
    const fakeTx = {
      simulationData: { result: { retval: record } },
      get result(): never {
        throw layoutError;
      },
    };
    const client = Object.assign(
      new EscrowClient({
        contractId: Keypair.random().publicKey(),
        rpcUrl: "https://127.0.0.1:1",
      }),
      { contractClient: () => ({ get_escrow: async () => fakeTx }) }
    );

    const escrow = await client.getEscrow(4n);

    expect(escrow.refundTo).toBe(payer);
    expect(escrow.status).toBe("Released");
    expect(escrow.releaseNotBefore).toBeUndefined();
  });

  it("rethrows a decode failure when the result is not an escrow map", async () => {
    const layoutError = new TypeError("not an escrow record");
    const fakeTx = {
      simulationData: { result: { retval: xdr.ScVal.scvVoid() } },
      get result(): never {
        throw layoutError;
      },
    };
    const client = Object.assign(
      new EscrowClient({
        contractId: Keypair.random().publicKey(),
        rpcUrl: "https://127.0.0.1:1",
      }),
      { contractClient: () => ({ get_escrow: async () => fakeTx }) }
    );

    await expect(client.getEscrow(5n)).rejects.toBe(layoutError);
  });
});

describe("getEscrows (batched getLedgerEntries)", () => {
  it("pins DataKey::Escrow(id) encoding to Soroban's enum(Symbol, u64) persistent key", () => {
    const contractId = "CAHQ4J3T23WSIBBG6SI6EAYR5Q2HIPKG5YMC4SMZBOTYA6MYK2VADEV5";
    const key = escrowLedgerKey(contractId, 42n);
    const cd = key.contractData();

    expect(cd.durability().name).toBe("persistent");
    expect(Address.fromScAddress(cd.contract()).toString()).toBe(contractId);
    expect(cd.key().toXDR("base64")).toBe(
      escrowDataKey(42n).toXDR("base64"),
    );
    const vec = cd.key().vec()!;
    expect(vec).toHaveLength(2);
    expect(vec[0].sym().toString()).toBe("Escrow");
    expect(vec[1].u64().toString()).toBe("42");
  });

  it("returns an empty Map without calling RPC when given no ids", async () => {
    const getLedgerEntries = vi.fn();
    const client = Object.assign(
      new EscrowClient({
        contractId: "CAHQ4J3T23WSIBBG6SI6EAYR5Q2HIPKG5YMC4SMZBOTYA6MYK2VADEV5",
        rpcUrl: "https://127.0.0.1:1",
      }),
      {
        ensureNetworkVerified: vi.fn(async () => {}),
        rpc: { getLedgerEntries },
      },
    );

    const result = await client.getEscrows([]);
    expect(result.size).toBe(0);
    expect(getLedgerEntries).not.toHaveBeenCalled();
  });

  it("batches getLedgerEntries calls, decodes records, and returns undefined for missing ids", async () => {
    const contractId = "CAHQ4J3T23WSIBBG6SI6EAYR5Q2HIPKG5YMC4SMZBOTYA6MYK2VADEV5";
    const { record, payer, payee } = legacyEscrowRecord();
    const key1 = escrowLedgerKey(contractId, 1n);

    const getLedgerEntries = vi.fn(async (...keys: xdr.LedgerKey[]) => ({
      latestLedger: 1000,
      entries: keys
        .filter((k) => k.toXDR("base64") === key1.toXDR("base64"))
        .map((k) => ({
          key: k,
          val: xdr.LedgerEntryData.contractData(
            new xdr.ContractDataEntry({
              ext: new xdr.ExtensionPoint(0),
              contract: Address.fromString(contractId).toScAddress(),
              key: escrowDataKey(1n),
              durability: xdr.ContractDataDurability.persistent(),
              val: record,
            }),
          ),
          liveUntilLedgerSeq: 2000,
        })),
    }));

    const client = Object.assign(
      new EscrowClient({ contractId, rpcUrl: "https://127.0.0.1:1" }),
      {
        ensureNetworkVerified: vi.fn(async () => {}),
        rpc: { getLedgerEntries },
      },
    );

    const result = await client.getEscrows([1n, 2n, 1n]);
    expect(getLedgerEntries).toHaveBeenCalledTimes(1);
    expect(Array.from(result.keys())).toEqual([1n, 2n]);
    expect(result.get(1n)?.payer).toBe(payer);
    expect(result.get(1n)?.payee).toBe(payee);
    expect(result.get(2n)).toBeUndefined();
  });

  it("throws ArchivedEntryError when an entry's liveUntilLedgerSeq is below latestLedger", async () => {
    const contractId = "CAHQ4J3T23WSIBBG6SI6EAYR5Q2HIPKG5YMC4SMZBOTYA6MYK2VADEV5";
    const { record } = legacyEscrowRecord();
    const key1 = escrowLedgerKey(contractId, 1n);

    const getLedgerEntries = vi.fn(async () => ({
      latestLedger: 1000,
      entries: [
        {
          key: key1,
          val: xdr.LedgerEntryData.contractData(
            new xdr.ContractDataEntry({
              ext: new xdr.ExtensionPoint(0),
              contract: Address.fromString(contractId).toScAddress(),
              key: escrowDataKey(1n),
              durability: xdr.ContractDataDurability.persistent(),
              val: record,
            }),
          ),
          liveUntilLedgerSeq: 999,
        },
      ],
    }));

    const client = Object.assign(
      new EscrowClient({ contractId, rpcUrl: "https://127.0.0.1:1" }),
      {
        ensureNetworkVerified: vi.fn(async () => {}),
        rpc: { getLedgerEntries },
      },
    );

    await expect(client.getEscrows([1n])).rejects.toThrow(ArchivedEntryError);
  });
});
