import type {
  CreateEscrowParams,
  Escrow,
  EscrowClientConfig,
  EscrowStatus,
  ReleaseOrRefundParams,
} from "../index.js";
import type { Keypair } from "@stellar/stellar-sdk";

export type FakeFailureKind = "timeout" | "rpcError" | "notFundedRace";
export type FakeOperation = "createEscrow" | "getStatus" | "getEscrow" | "release" | "refund";

export interface FakeFailure {
  kind: FakeFailureKind;
  /** For a simulated concurrent settlement, the competing transaction's result. */
  winner?: "Released" | "Refunded";
}

export type FakeEscrowErrorCode =
  | "NotFound"
  | "InvalidAmount"
  | "Unauthorized"
  | "NotFunded"
  | "InvalidRefundAfter"
  | "Timeout"
  | "RpcError";

export class FakeEscrowError extends Error {
  constructor(readonly code: FakeEscrowErrorCode) {
    super(code);
    this.name = "FakeEscrowError";
  }
}

/** A deterministic unix-seconds clock for timeout and race tests. */
export class FakeClock {
  constructor(private currentTime: bigint) {}

  now(): bigint {
    return this.currentTime;
  }

  advanceBy(seconds: bigint | number): void {
    const interval = BigInt(seconds);
    if (interval < 0n) throw new RangeError("FakeClock cannot move backwards");
    this.currentTime += interval;
  }
}

interface FakeEscrowRecord extends Escrow {
  id: bigint;
}

/**
 * In-memory implementation of EscrowClient for consumer unit tests.
 * It models the public contract rules, but deliberately does not model
 * token balances, fees, RPC simulation, or cryptographic signatures.
 */
export class FakeEscrowClient {
  private readonly escrows = new Map<bigint, FakeEscrowRecord>();
  private readonly failures: Array<{ operation: FakeOperation; failure: FakeFailure }> = [];
  private nextId = 0n;
  private nextTx = 0;
  private readonly clock: () => bigint;

  constructor(config: EscrowClientConfig & { clock?: () => bigint } ) {
    // Keep constructor shape compatible with EscrowClient; no config values
    // are needed by the in-memory implementation.
    this.clock = config.clock ?? (() => BigInt(Math.floor(Date.now() / 1000)));
  }

  /** Queue one deterministic transport or concurrent-settlement failure. */
  failNext(operation: FakeOperation, failure: FakeFailure): void {
    this.failures.push({ operation, failure });
  }

  async createEscrow(params: CreateEscrowParams): Promise<{ escrowId: bigint; txHash: string }> {
    this.maybeFail("createEscrow");
    if (params.amount <= 0n) throw new FakeEscrowError("InvalidAmount");
    if (params.refundAfter !== undefined && params.refundAfter <= this.clock()) {
      throw new FakeEscrowError("InvalidRefundAfter");
    }

    const escrowId = this.nextId++;
    this.escrows.set(escrowId, {
      id: escrowId,
      payer: signerAddress(params.payer),
      payee: params.payee,
      token: params.token,
      amount: params.amount,
      conditionRef: params.conditionRef,
      releaser: params.releaser,
      refundAfter: params.refundAfter,
      status: "Funded",
    });
    return { escrowId, txHash: `fake-tx-${++this.nextTx}` };
  }

  async getStatus(escrowId: bigint): Promise<EscrowStatus> {
    this.maybeFail("getStatus");
    return this.getRecord(escrowId).status;
  }

  async getEscrow(escrowId: bigint): Promise<Escrow> {
    this.maybeFail("getEscrow");
    const { id: _id, ...record } = this.getRecord(escrowId);
    return { ...record };
  }

  async release(params: ReleaseOrRefundParams): Promise<{ txHash: string }> {
    const record = this.getRecord(params.escrowId);
    this.maybeFail("release", record);
    this.requireFunded(record);
    if (signerAddress(params.caller) !== record.releaser) {
      throw new FakeEscrowError("Unauthorized");
    }
    record.status = "Released";
    return { txHash: `fake-tx-${++this.nextTx}` };
  }

  async refund(params: ReleaseOrRefundParams): Promise<{ txHash: string }> {
    const record = this.getRecord(params.escrowId);
    this.maybeFail("refund", record);
    this.requireFunded(record);
    const caller = signerAddress(params.caller);
    const timeoutPassed = record.refundAfter !== undefined && this.clock() >= record.refundAfter;
    if (caller !== record.releaser && !timeoutPassed) {
      throw new FakeEscrowError("Unauthorized");
    }
    record.status = "Refunded";
    return { txHash: `fake-tx-${++this.nextTx}` };
  }

  private getRecord(escrowId: bigint): FakeEscrowRecord {
    const record = this.escrows.get(escrowId);
    if (!record) throw new FakeEscrowError("NotFound");
    return record;
  }

  private requireFunded(record: FakeEscrowRecord): void {
    if (record.status !== "Funded") throw new FakeEscrowError("NotFunded");
  }

  private maybeFail(operation: FakeOperation, record?: FakeEscrowRecord): void {
    const index = this.failures.findIndex((queued) => queued.operation === operation);
    if (index < 0) return;
    const [{ failure }] = this.failures.splice(index, 1);

    if (failure.kind === "notFundedRace") {
      if (!record) throw new FakeEscrowError("NotFunded");
      record.status = failure.winner ?? (operation === "release" ? "Refunded" : "Released");
      throw new FakeEscrowError("NotFunded");
    }
    throw new FakeEscrowError(failure.kind === "timeout" ? "Timeout" : "RpcError");
  }
}

function signerAddress(signer: Keypair): string {
  return signer.publicKey();
}
