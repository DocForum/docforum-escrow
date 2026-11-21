import type {
  CreateEscrowParams,
  Escrow,
  EscrowStatus,
  ReleaseOrRefundParams,
} from "../index.js";
import { signerAddress } from "../signers/types.js";

/** Config accepted by the fake; only the injectable clock is used in-memory. */
export interface FakeEscrowClientConfig {
  clock?: () => bigint;
  [key: string]: unknown;
}

/** Kinds of failure {@link FakeEscrowClient.failNext} can inject. */
export type FakeFailureKind = "timeout" | "rpcError" | "notFundedRace";
/** Client methods a failure can be queued for. */
export type FakeOperation = "createEscrow" | "getStatus" | "getEscrow" | "release" | "refund";

/** One queued failure for {@link FakeEscrowClient.failNext}. */
export interface FakeFailure {
  kind: FakeFailureKind;
  /** For a simulated concurrent settlement, the competing transaction's result. */
  winner?: "Released" | "Refunded";
}

/** Error codes the fake throws, mirroring the contract errors it models plus transport failures. */
export type FakeEscrowErrorCode =
  | "NotFound"
  | "InvalidAmount"
  | "Unauthorized"
  | "NotFunded"
  | "InvalidRefundAfter"
  | "Timeout"
  | "RpcError";

/** Error thrown by {@link FakeEscrowClient}; `code` says which rule or failure triggered it. */
export class FakeEscrowError extends Error {
  constructor(readonly code: FakeEscrowErrorCode) {
    super(code);
    this.name = "FakeEscrowError";
  }
}

/** A deterministic unix-seconds clock for timeout and race tests. */
export class FakeClock {
  constructor(private currentTime: bigint) {}

  /** Current time in unix seconds. */
  now(): bigint {
    return this.currentTime;
  }

  /** Move the clock forward by `seconds`; it never moves backwards. */
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

  constructor(config: FakeEscrowClientConfig) {
    // Keep constructor shape compatible with EscrowClient; no config values
    // are needed by the in-memory implementation.
    this.clock = config.clock ?? (() => BigInt(Math.floor(Date.now() / 1000)));
  }

  /** Queue one deterministic transport or concurrent-settlement failure. */
  failNext(operation: FakeOperation, failure: FakeFailure): void {
    this.failures.push({ operation, failure });
  }

  /** Record a new `Funded` escrow, validating amount and `refundAfter` like the contract. */
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
      releasers: [params.releaser],
      threshold: 1,
      refundAfter: params.refundAfter,
      releaseNotBefore: params.releaseNotBefore,
      feeRecipient: params.feeRecipient,
      feeBps: params.feeBps,
      notifyPayee: params.notifyPayee ?? false,
      refundTo: params.refundTo ?? signerAddress(params.payer),
      requiresAcceptance: params.requiresAcceptance ?? false,
      status: "Funded",
    });
    return { escrowId, txHash: `fake-tx-${++this.nextTx}` };
  }

  /** Status of an escrow; throws `NotFound` for an unknown id. */
  async getStatus(escrowId: bigint): Promise<EscrowStatus> {
    this.maybeFail("getStatus");
    return this.getRecord(escrowId).status;
  }

  /** Full escrow record; throws `NotFound` for an unknown id. */
  async getEscrow(escrowId: bigint): Promise<Escrow> {
    this.maybeFail("getEscrow");
    const { id: _id, ...record } = this.getRecord(escrowId);
    return { ...record };
  }

  /** Release to the payee; only a releaser may, and only while `Funded`. */
  async release(params: ReleaseOrRefundParams): Promise<{ txHash: string }> {
    const record = this.getRecord(params.escrowId);
    this.maybeFail("release", record);
    this.requireFunded(record);
    if (record.threshold !== 1 || !record.releasers.includes(signerAddress(params.caller))) {
      throw new FakeEscrowError("Unauthorized");
    }
    record.status = "Released";
    return { txHash: `fake-tx-${++this.nextTx}` };
  }

  /** Refund the payer; a releaser may at any time, anyone once `refundAfter` has passed. */
  async refund(params: ReleaseOrRefundParams): Promise<{ txHash: string }> {
    const record = this.getRecord(params.escrowId);
    this.maybeFail("refund", record);
    this.requireFunded(record);
    const caller = signerAddress(params.caller);
    const timeoutPassed = record.refundAfter !== undefined && this.clock() >= record.refundAfter;
    if (!record.releasers.includes(caller) && !timeoutPassed) {
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
