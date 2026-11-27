import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, StrKey, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { randomBytes } from "node:crypto";
import type { SorobanEvent } from "@subql/types-stellar";

// In-memory fakes for the generated SubQuery entities. The mapping imports them
// through src/entities, which is mocked here, so these tests need no codegen,
// database or network.
const store = vi.hoisted(() => ({
  escrows: new Map<string, Record<string, unknown>>(),
  events: [] as Record<string, unknown>[],
}));

vi.mock("../src/entities", () => {
  class Escrow {
    id: string;
    constructor(id: string, ...fields: unknown[]) {
      this.id = id;
      void fields;
    }
    static async get(id: string): Promise<Escrow | undefined> {
      const saved = store.escrows.get(id);
      if (!saved) return undefined;
      return Object.assign(new Escrow(id), saved);
    }
    async save(): Promise<void> {
      store.escrows.set(this.id, { ...this });
    }
  }
  class EscrowEvent {
    id: string;
    escrowId: bigint;
    action: string;
    transactionHash: string;
    ledger: bigint;
    constructor(id: string, escrowId: bigint, action: string, transactionHash: string, ledger: bigint) {
      this.id = id;
      this.escrowId = escrowId;
      this.action = action;
      this.transactionHash = transactionHash;
      this.ledger = ledger;
    }
    async save(): Promise<void> {
      store.events.push({ ...this });
    }
  }
  return { Escrow, EscrowEvent };
});

const { handleEscrowEvent } = await import("../src/mappings/index.js");

const account = () => Keypair.random().publicKey();
const contractAddress = () => StrKey.encodeContract(randomBytes(32));

const CONTRACT_ID = contractAddress();
const PAYER = account();
const PAYEE = account();
const OTHER_PAYEE = account();
const RELEASER = account();
const NEW_RELEASER = account();
const TOKEN = contractAddress();

const address = (value: string) => nativeToScVal(value, { type: "address" });
const i128 = (value: bigint) => nativeToScVal(value, { type: "i128" });
const u64 = (value: bigint) => nativeToScVal(value, { type: "u64" });
const u32 = (value: number) => nativeToScVal(value, { type: "u32" });
const symbol = (value: string) => xdr.ScVal.scvSymbol(value);
const text = (value: string) => nativeToScVal(value, { type: "string" });
const bool = (value: boolean) => xdr.ScVal.scvBool(value);
const vec = (values: xdr.ScVal[]) => xdr.ScVal.scvVec(values);
const none = () => xdr.ScVal.scvVoid();

interface SnapshotFields {
  payer?: string;
  payee?: string;
  amount?: bigint;
  releasers?: string[];
  threshold?: number;
  refundAfter?: bigint | null;
  acceptedAt?: bigint | null;
  status?: string;
}

/** Builds the `ESCROW` snapshot payload: 12 fields, or 13 with the nested fee. */
function snapshotValue(fields: SnapshotFields = {}, options: { withFee?: boolean } = {}): xdr.ScVal {
  const parts: xdr.ScVal[] = [
    address(fields.payer ?? PAYER),
    address(fields.payee ?? PAYEE),
    address(TOKEN),
    i128(fields.amount ?? 1_000n),
    text("invoice-1"),
    vec((fields.releasers ?? [RELEASER]).map(address)),
    u32(fields.threshold ?? 1),
    fields.refundAfter == null ? none() : u64(fields.refundAfter),
    bool(true),
    bool(false),
    fields.acceptedAt == null ? none() : u64(fields.acceptedAt),
    symbol(fields.status ?? "Funded"),
  ];
  if (options.withFee) {
    parts.push(vec([address(OTHER_PAYEE), u32(25)]));
  }
  return vec(parts);
}

function event(topic: unknown[], value: xdr.ScVal, ledger = 100): SorobanEvent {
  return {
    type: "contract",
    contractId: CONTRACT_ID,
    topic: topic.map((item) =>
      typeof item === "string" ? symbol(item) : nativeToScVal(item as bigint, { type: "u64" }),
    ),
    value,
    txHash: `tx-${ledger}`,
    id: `${ledger}-0`,
    // SubQuery resolves the event's ledger to a full block record.
    ledger: { sequence: ledger },
  } as unknown as SorobanEvent;
}

const snapshot = (id: bigint, fields: SnapshotFields = {}, ledger = 100, withFee = false) =>
  event(["ESCROW", "created", id], snapshotValue(fields, { withFee }), ledger);

const partial = (action: string, id: bigint, values: xdr.ScVal[], ledger = 100) =>
  event([action, id], vec(values), ledger);

function seedEscrow(id: bigint, overrides: Record<string, unknown> = {}): void {
  store.escrows.set(id.toString(), {
    id: id.toString(),
    escrowId: id,
    payer: PAYER,
    payee: PAYEE,
    token: TOKEN,
    amount: 1_000n,
    conditionRef: "invoice-1",
    releasers: [RELEASER],
    threshold: 1n,
    refundAfter: undefined,
    notifyPayee: true,
    requiresAcceptance: false,
    acceptedAt: undefined,
    feeRecipient: undefined,
    feeBps: undefined,
    status: "Funded",
    updatedLedger: 100n,
    ...overrides,
  });
}

beforeEach(() => {
  store.escrows.clear();
  store.events.length = 0;
});

describe("ESCROW snapshots", () => {
  it("indexes the 13-field layout including the nested protocol fee", async () => {
    await handleEscrowEvent(snapshot(1n, {}, 100, true));

    const record = store.escrows.get("1");
    expect(record).toMatchObject({
      payer: PAYER,
      payee: PAYEE,
      amount: 1_000n,
      conditionRef: "invoice-1",
      releasers: [RELEASER],
      threshold: 1n,
      status: "Funded",
      updatedLedger: 100n,
      feeRecipient: OTHER_PAYEE,
      feeBps: 25n,
    });
    expect(store.events).toHaveLength(1);
    expect(store.events[0]).toMatchObject({ escrowId: 1n, action: "created", ledger: 100n });
  });

  it("indexes the older 12-field layout as fee-free", async () => {
    await handleEscrowEvent(snapshot(2n, { status: "Released", amount: 4_200n }));

    const record = store.escrows.get("2");
    expect(record).toMatchObject({ amount: 4_200n, status: "Released" });
    expect(record?.feeRecipient).toBeUndefined();
    expect(record?.feeBps).toBeUndefined();
  });

  it("ignores unknown lifecycle actions and malformed payloads", async () => {
    await handleEscrowEvent(event(["ESCROW", "unknown-action", 3n], snapshotValue()));
    await handleEscrowEvent(event(["ESCROW", "created", 3n], vec([symbol("short")])));
    expect(store.escrows.size).toBe(0);
    expect(store.events).toHaveLength(0);
  });
});

describe("non-lifecycle events", () => {
  it("applies pay_xfer to the payee only", async () => {
    seedEscrow(10n);

    await handleEscrowEvent(partial("pay_xfer", 10n, [address(PAYEE), address(OTHER_PAYEE)], 101));

    expect(store.escrows.get("10")).toMatchObject({
      payee: OTHER_PAYEE,
      amount: 1_000n,
      releasers: [RELEASER],
      updatedLedger: 101n,
    });
    expect(store.events.at(-1)).toMatchObject({ action: "pay_xfer", escrowId: 10n });
  });

  it("applies rotate to the releaser set", async () => {
    seedEscrow(11n, { releasers: [RELEASER, OTHER_PAYEE], threshold: 2n });

    await handleEscrowEvent(partial("rotate", 11n, [address(RELEASER), address(NEW_RELEASER)]));

    expect(store.escrows.get("11")).toMatchObject({
      releasers: [NEW_RELEASER, OTHER_PAYEE],
      threshold: 2n,
    });
  });

  it("applies top_up's updated total", async () => {
    seedEscrow(12n);

    await handleEscrowEvent(partial("top_up", 12n, [i128(500n), i128(1_500n)]));

    expect(store.escrows.get("12")).toMatchObject({ amount: 1_500n });
  });

  it("applies accepted's timestamp", async () => {
    seedEscrow(13n, { requiresAcceptance: true });

    await handleEscrowEvent(partial("accepted", 13n, [address(PAYEE), u64(1_700_000_000n)]));

    expect(store.escrows.get("13")).toMatchObject({ acceptedAt: 1_700_000_000n });
  });

  it("applies contribute's new funded total", async () => {
    seedEscrow(14n, { amount: 0n });

    await handleEscrowEvent(partial("contrib", 14n, [address(PAYER), i128(300n), i128(300n)], 102));
    await handleEscrowEvent(partial("contrib", 14n, [address(OTHER_PAYEE), i128(200n), i128(500n)], 103));

    expect(store.escrows.get("14")).toMatchObject({ amount: 500n, updatedLedger: 103n });
  });

  it("applies claimed's refund to the remaining amount", async () => {
    seedEscrow(15n, { amount: 500n });

    await handleEscrowEvent(partial("claimed", 15n, [address(PAYER), i128(200n)]));

    expect(store.escrows.get("15")).toMatchObject({ amount: 300n });
  });

  it("never lets an older event overwrite a newer snapshot", async () => {
    seedEscrow(16n, { payee: OTHER_PAYEE, updatedLedger: 200n });

    await handleEscrowEvent(partial("pay_xfer", 16n, [address(PAYEE), address(PAYEE)], 150));

    expect(store.escrows.get("16")).toMatchObject({ payee: OTHER_PAYEE, updatedLedger: 200n });
    // The event still happened, so it stays in the escrow's history.
    expect(store.events.at(-1)).toMatchObject({ action: "pay_xfer", ledger: 150n });
  });

  it("skips events for escrows created before the start ledger", async () => {
    await expect(
      handleEscrowEvent(partial("pay_xfer", 99n, [address(PAYEE), address(OTHER_PAYEE)])),
    ).resolves.toBeUndefined();
    expect(store.escrows.size).toBe(0);
    expect(store.events).toHaveLength(0);
  });

  it("ignores malformed payloads without touching the record", async () => {
    seedEscrow(17n);

    await handleEscrowEvent(partial("top_up", 17n, [i128(500n)]));
    await handleEscrowEvent(partial("contrib", 17n, [address(PAYER), i128(500n)]));

    expect(store.escrows.get("17")).toMatchObject({ amount: 1_000n, updatedLedger: 100n });
  });
});
