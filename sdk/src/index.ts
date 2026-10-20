// @docforum/escrow-sdk — ergonomic wrapper around the generated Soroban
// contract client (src/generated/contract-client.ts). Consumers (e.g.
// docforum-core's `payments` module — see its ARCHITECTURE.md ADR 0002)
// should import from here, not from src/generated/ directly.
//
// No PHI, no healthcare concepts here (hard rule 1) — types stay generic
// (payer/payee/amount, not e.g. "patient"). Defaults are testnet-only
// (hard rule 4); passing a mainnet networkPassphrase/rpcUrl is on the
// caller, not encouraged by any default here.
import { Keypair, scValToNative, xdr } from "@stellar/stellar-sdk";
import { Server as RpcServer, type Api } from "@stellar/stellar-sdk/rpc";
import { Client as EscrowContractClient, type EscrowStatus as GeneratedEscrowStatus } from "./generated/contract-client.js";

export { Keypair };
export { EscrowIndexerClient } from "./indexer-client.js";
export type { EscrowIndexerClientConfig, EscrowPage, IndexedEscrow } from "./indexer-client.js";

export type EscrowStatus = "Funded" | "Released" | "Refunded";

export type EscrowEventType = "created" | "released" | "refunded";
interface EscrowEventBase {
  ledger: number;
  cursor: string;
  transactionHash: string;
  data: unknown;
}
/**
 * Unknown variants are retained with decoded topics so newer contract event
 * schemas remain observable to older SDK consumers instead of crashing.
 */
export type EscrowEvent = (EscrowEventBase & {
  type: EscrowEventType;
  escrowId: bigint;
}) | (EscrowEventBase & {
  type: "unknown";
  eventName?: string;
  escrowId?: bigint;
  topics: unknown[];
});
export type GetEventsParams = {
  types?: EscrowEventType[];
  escrowId?: bigint;
} & (
  | { /** First ledger to scan (inclusive). */ fromLedger: number; cursor?: never }
  | { /** Opaque RPC cursor returned from a prior page/event. */ cursor: string; fromLedger?: never }
);
export interface GetEventsResult { events: EscrowEvent[]; nextCursor: string; }

/** The requested cursor predates the event history retained by the RPC server. */
export class EventCursorExpiredError extends Error {
  readonly name = "EventCursorExpiredError";
  constructor(message = "The event cursor is older than the RPC server's retention window.") { super(message); }
}

export interface SubscribeOptions {
  cursor?: string;
  pollIntervalMs?: number;
  types?: EscrowEventType[];
  escrowId?: bigint;
  onError?: (error: unknown) => void;
}

function safeScValToNative(value: xdr.ScVal): unknown {
  try { return scValToNative(value); }
  catch { return { xdr: value.toXDR("base64") }; }
}

function isRetentionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /cursor.{0,40}(older|retention|oldest)|older.{0,40}(cursor|ledger|retention)|start ledger.{0,40}(oldest|retention)/i.test(message);
}

/** Everything the contract stores about one escrow — what `getEscrow` returns. */
export interface Escrow {
  payer: string;
  payee: string;
  token: string;
  amount: bigint;
  conditionRef: string;
  /**
   * The address permitted to call `release`/`refund` (docs/adr/0002) —
   * unless `refundAfter` has passed, in which case anyone may refund.
   */
  releaser: string;
  /**
   * Optional deadline in unix seconds after which **anyone** may refund —
   * always back to `payer` (docs/adr/0004). `undefined` means no timeout:
   * refunds stay releaser-only forever. Payees should check this before
   * relying on a `Funded` escrow (threat model T8).
   */
  refundAfter?: bigint;
  status: EscrowStatus;
}

const TESTNET_RPC_URL = "https://soroban-testnet.stellar.org";
const TESTNET_NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

export interface EscrowClientConfig {
  /** The deployed docforum-escrow contract's address (`C…`). */
  contractId: string;
  /** Default: Soroban testnet RPC. */
  rpcUrl?: string;
  /** Default: Stellar testnet passphrase. */
  networkPassphrase?: string;
}

export interface CreateEscrowParams {
  /** Signs and pays for this call; funds are pulled from this account. */
  payer: Keypair;
  payee: string;
  token: string;
  amount: bigint;
  conditionRef: string;
  /**
   * The only address later permitted to call `release`/`refund` on this
   * escrow (see docforum-escrow's docs/adr/0002). Typically the calling
   * application's own service identity, not the payer or payee.
   */
  releaser: string;
  /**
   * Optional unix timestamp (seconds) after which anyone may refund this
   * escrow — always back to `payer` (docs/adr/0004). Must be strictly in
   * the future at creation, or the contract rejects with
   * `InvalidRefundAfter` (error 5). Omit for no timeout: refunds stay
   * releaser-only, exactly as in 0.2.x.
   */
  refundAfter?: bigint;
}

export interface ReleaseOrRefundParams {
  escrowId: bigint;
  /** Must be the escrow's `releaser` (set at creation) — see docs/adr/0002. */
  caller: Keypair;
}

/** The relayer pays the transaction fee; the releaser signs only contract auth. */
export interface RelayedAuthorizationParams {
  escrowId: bigint;
  releaser: Keypair;
  relayer: Keypair;
}

/** Serialized, simulated transaction containing a short-lived signed auth entry. */
export interface RelayedAuthorization {
  transaction: string;
  expiresAtLedger: number;
}

/**
 * Thin client for the docforum-escrow Soroban contract. Wraps
 * `create_escrow`/`get_status`/`get_escrow`/`release`/`refund` with plain
 * TypeScript types and no manual XDR/signing plumbing.
 */
export class EscrowClient {
  private readonly contractId: string;
  private readonly rpcUrl: string;
  private readonly networkPassphrase: string;
  private readonly rpc: RpcServer;

  constructor(config: EscrowClientConfig) {
    this.contractId = config.contractId;
    this.rpcUrl = config.rpcUrl ?? TESTNET_RPC_URL;
    this.networkPassphrase = config.networkPassphrase ?? TESTNET_NETWORK_PASSPHRASE;
    this.rpc = new RpcServer(this.rpcUrl);
  }

  private contractClient(signer?: Keypair): EscrowContractClient {
    return new EscrowContractClient({
      contractId: this.contractId,
      rpcUrl: this.rpcUrl,
      networkPassphrase: this.networkPassphrase,
      ...(signer ? { publicKey: signer.publicKey(), signTransaction: signer } : {}),
    });
  }

  /** Locks `amount` of `token` from `payer`, held for `payee`. Returns the new escrow's id and the funding transaction's hash. */
  async createEscrow(params: CreateEscrowParams): Promise<{ escrowId: bigint; txHash: string }> {
    const client = this.contractClient(params.payer);
    const tx = await client.create_escrow({
      payer: params.payer.publicKey(),
      payee: params.payee,
      token: params.token,
      amount: params.amount,
      condition_ref: params.conditionRef,
      releaser: params.releaser,
      refund_after: params.refundAfter,
    });
    const sent = await tx.signAndSend();
    return { escrowId: sent.result.unwrap(), txHash: sent.sendTransactionResponse!.hash };
  }

  /** Read-only status query. Throws if `escrowId` doesn't exist. */
  async getStatus(escrowId: bigint): Promise<EscrowStatus> {
    const client = this.contractClient();
    const tx = await client.get_status({ escrow_id: escrowId });
    const status: GeneratedEscrowStatus = tx.result.unwrap();
    return status.tag;
  }

  /**
   * Read-only: everything stored about `escrowId` — including
   * `releaser` and `refundAfter`, which payees should check before
   * relying on a `Funded` escrow (docs/adr/0004, threat model T8).
   * Throws if `escrowId` doesn't exist.
   */
  async getEscrow(escrowId: bigint): Promise<Escrow> {
    const client = this.contractClient();
    const tx = await client.get_escrow({ escrow_id: escrowId });
    const data = tx.result.unwrap();
    return {
      payer: data.payer,
      payee: data.payee,
      token: data.token,
      amount: data.amount,
      conditionRef: data.condition_ref,
      releaser: data.releaser,
      // The generated client decodes a contract `None` as `null`; the
      // public surface uses `undefined` for "no deadline" (consistent
      // with `CreateEscrowParams.refundAfter` being absent).
      refundAfter: data.refund_after ?? undefined,
      status: data.status.tag,
    };
  }

  /** Moves the escrow's funds to its payee. Throws if `caller` isn't the escrow's `releaser`, or the escrow isn't `Funded`. Returns the transaction's hash. */
  async release(params: ReleaseOrRefundParams): Promise<{ txHash: string }> {
    const client = this.contractClient(params.caller);
    const tx = await client.release({ escrow_id: params.escrowId, caller: params.caller.publicKey() });
    const sent = await tx.signAndSend();
    sent.result.unwrap();
    return { txHash: sent.sendTransactionResponse!.hash };
  }

  /**
   * Returns the escrow's funds to its payer. Normally `caller` must be
   * the escrow's `releaser`; once `refundAfter` has passed, anyone may
   * call it — still only back to the payer (docs/adr/0004). Returns the
   * transaction's hash.
   */
  async refund(params: ReleaseOrRefundParams): Promise<{ txHash: string }> {
    const client = this.contractClient(params.caller);
    const tx = await client.refund({ escrow_id: params.escrowId, caller: params.caller.publicKey() });
    const sent = await tx.signAndSend();
    sent.result.unwrap();
    return { txHash: sent.sendTransactionResponse!.hash };
  }

  /** Reads one page of lifecycle events emitted by this escrow contract. */
  async getEvents(params: GetEventsParams): Promise<GetEventsResult> {
    if (params.cursor !== undefined && params.fromLedger !== undefined) {
      throw new TypeError("Provide either cursor or fromLedger, not both.");
    }
    if (params.fromLedger !== undefined && (!Number.isSafeInteger(params.fromLedger) || params.fromLedger < 1)) {
      throw new RangeError("fromLedger must be a positive safe integer.");
    }
    const filter: Api.EventFilter = { type: "contract", contractIds: [this.contractId] };
    const request: Api.GetEventsRequest = "cursor" in params && params.cursor !== undefined
      ? { cursor: params.cursor, filters: [filter], limit: 100 }
      : { startLedger: params.fromLedger, filters: [filter], limit: 100 };
    let response: Api.GetEventsResponse;
    try {
      response = await this.rpc.getEvents(request);
    } catch (error) {
      if (isRetentionError(error)) throw new EventCursorExpiredError(error instanceof Error ? error.message : undefined);
      throw error;
    }
    const allowed = params.types ? new Set(params.types) : undefined;
    const events: EscrowEvent[] = [];
    for (const raw of response.events) {
      if (raw.type !== "contract" || raw.contractId?.toString() !== this.contractId) continue;
      const nativeTopics = raw.topic.map(safeScValToNative);
      const eventName = nativeTopics.find((v) => v === "created" || v === "released" || v === "refunded") as EscrowEventType | undefined;
      const unknownName = nativeTopics.find((v) => typeof v === "string") as string | undefined;
      const type = eventName;
      if (type && allowed && !allowed.has(type)) continue;
      const rawId = nativeTopics.find((v): v is bigint | number => typeof v === "bigint" || (typeof v === "number" && Number.isSafeInteger(v)));
      const escrowId = rawId === undefined ? undefined : BigInt(rawId);
      if (params.escrowId !== undefined && escrowId !== params.escrowId) continue;
      const base = { ledger: raw.ledger, cursor: raw.id, transactionHash: raw.txHash, data: safeScValToNative(raw.value) };
      if (type && escrowId !== undefined) events.push({ ...base, type, escrowId });
      else events.push({ ...base, type: "unknown", ...(unknownName ? { eventName: unknownName } : {}), ...(escrowId !== undefined ? { escrowId } : {}), topics: nativeTopics });
    }
    return { events, nextCursor: response.cursor };
  }

  /**
   * Polls event pages in order. Each handler call is awaited before the next
   * event is delivered, so slow handlers apply back-pressure without drops.
   * The returned stop function ends polling; persist the last delivered
   * event cursor (or the cursor from getEvents) to resume after restart.
   */
  subscribe(handler: (event: EscrowEvent) => void | Promise<void>, options: SubscribeOptions = {}): () => void {
    const pollIntervalMs = options.pollIntervalMs ?? 5_000;
    if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 1) throw new RangeError("pollIntervalMs must be at least 1.");
    let stopped = false;
    let cursor = options.cursor;
    const poll = async (): Promise<void> => {
      while (!stopped) {
        try {
          const page = cursor !== undefined
            ? await this.getEvents({ cursor, types: options.types, escrowId: options.escrowId })
            : await this.getEvents({ fromLedger: (await this.rpc.getLatestLedger()).sequence, types: options.types, escrowId: options.escrowId });
          for (const event of page.events) {
            if (stopped) break;
            await handler(event);
            cursor = event.cursor;
          }
          // Advance across pages with no matching events, including filtered events.
          cursor = page.nextCursor;
        } catch (error) {
          if (!stopped) {
            if (options.onError) options.onError(error);
            else queueMicrotask(() => { throw error; });
          }
          return;
        }
        if (!stopped) await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
      }
    };
    void poll();
    return () => { stopped = true; };
  }
}
