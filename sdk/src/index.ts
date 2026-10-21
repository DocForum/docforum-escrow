// @docforum/escrow-sdk — ergonomic wrapper around the generated Soroban
// contract client (src/generated/contract-client.ts). Consumers (e.g.
// docforum-core's `payments` module — see its ARCHITECTURE.md ADR 0002)
// should import from here, not from src/generated/ directly.
//
// No PHI, no healthcare concepts here (hard rule 1) — types stay generic
// (payer/payee/amount, not e.g. "patient"). Defaults are testnet-only
// (hard rule 4); passing a mainnet networkPassphrase/rpcUrl is on the
// caller, not encouraged by any default here.
import {
  Address,
  BASE_FEE,
  FeeBumpTransaction,
  Keypair,
  Operation,
  Transaction,
  TransactionBuilder,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { Api, Server as RpcServer } from "@stellar/stellar-sdk/rpc";
import { Client as EscrowContractClient, type EscrowStatus as GeneratedEscrowStatus } from "./generated/contract-client.js";

export { Keypair };
export { EscrowIndexerClient } from "./indexer-client.js";
export type { EscrowIndexerClientConfig, EscrowPage, IndexedEscrow } from "./indexer-client.js";

export type EscrowStatus = "Funded" | "Released" | "Refunded" | "Disputed";

export type ArchivedEntryBehavior = "auto" | "error";

/** Typed error for contract calls that cannot restore archived ledger entries. */
export class ArchivedEntryError extends Error {
  readonly method: string;
  override readonly cause?: unknown;
  constructor(method: string, behavior: ArchivedEntryBehavior, cause?: unknown) {
    super(behavior === "auto"
      ? `Contract state needed by ${method} is archived and automatic restoration failed. Ensure the configured signer can pay the restoration fee.`
      : `Contract state needed by ${method} is archived. Set archivalBehavior to "auto" and provide a restore signer to restore it.`);
    this.name = "ArchivedEntryError";
    this.method = method;
    this.cause = cause;
  }
}

export function isArchivedEntryFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; message?: unknown };
  return candidate.name === "ExpiredState" ||
    (typeof candidate.message === "string" && /expired state|archived (?:contract )?state|automatic restoration attempt limit reached/i.test(candidate.message));
}

export type EscrowEventType = "created" | "released" | "refunded" | "disputed" | "resolved" | "settled";
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
   * The addresses permitted to settle this escrow (docs/adr/0002 for the
   * per-escrow releaser, docs/adr/0007 for M-of-N sets) — unless
   * `refundAfter` has passed, in which case anyone may refund. A plain
   * single-releaser escrow has exactly one entry here.
   */
  releasers: string[];
  /**
   * How many distinct addresses from `releasers` must authorize one
   * settlement. `1` means any single releaser can settle.
   */
  threshold: number;
  /**
   * Optional deadline in unix seconds after which **anyone** may refund —
   * always back to `payer` (docs/adr/0004). `undefined` means no timeout:
   * refunds stay releaser-only forever. Payees should check this before
   * relying on a `Funded` escrow (threat model T8).
   */
  refundAfter?: bigint;
  /** Earliest ledger timestamp at which release is allowed. Omit for immediate release. */
  releaseNotBefore?: bigint;
  /** Whether to call the contract payee's on_escrow_released hook. Defaults to false. */
  notifyPayee: boolean;
  /**
   * The address allowed to adjudicate a dispute over this escrow, set at
   * creation time (`createEscrow({ arbiter })`). `undefined` for escrows
   * created without one — those can be disputed but never resolved, so the
   * parties should agree on an arbiter before funding.
   */
  arbiter?: string;
  /**
   * The arbiter's recorded resolution, in basis points of `amount`. Only
   * present once `resolveDispute` has run; `settle` then pays both sides from
   * it. `undefined` before a resolution.
   */
  splitBps?: { payerBps: number; payeeBps: number };
  /**
   * Where every refund (releaser or timeout) sends the funds. Fixed at
   * creation; equals `payer` unless a sponsored escrow set a different
   * destination (docs/adr/0009). Payees can read it to see who a
   * reversal would pay.
   */
  refundTo: string;
  status: EscrowStatus;
}

const TESTNET_RPC_URL = "https://soroban-testnet.stellar.org";
const TESTNET_NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

/**
 * Maximum allowed length of `conditionRef` in bytes — must match the
 * contract's bound (currently 64 bytes, see contracts/escrow/src/lib.rs
 * and docs/threat-model.md T10). Validated client-side so callers fail
 * fast instead of paying network fees for a rejected transaction.
 *
 * Keep in sync with the contract: if the contract bound changes, update
 * this constant and bump the SDK's semver (hard rule 3).
 */
export const MAX_CONDITION_REF_LENGTH = 64;

/**
 * Maximum number of addresses in one escrow's releaser set — must match the
 * contract's `MAX_RELEASERS` (currently 10, see docs/adr/0007). Validated
 * client-side so callers fail fast instead of paying network fees for a
 * rejected transaction. Keep in sync with the contract; a change is an SDK
 * semver event (hard rule 3).
 */
export const MAX_RELEASERS = 10;

export interface EscrowClientConfig {
  /** The deployed docforum-escrow contract's address (`C…`). */
  contractId: string;
  /** Default: Soroban testnet RPC. */
  rpcUrl?: string;
  /** Default: Stellar testnet passphrase. */
  networkPassphrase?: string;
  /** Use the restore signer to authorize calls that automatically restore archived entries. */
  archivalBehavior?: ArchivedEntryBehavior;
  restoreSigner?: Keypair;
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
  /**
   * The only address allowed to adjudicate a dispute over this escrow. Omit
   * to create a pre-E6 escrow that can be disputed but never resolved. Use
   * `create_escrow_with_arbiter` under the hood when set.
   */
  arbiter?: string;
  /** Opt a contract payee into on_escrow_released(escrowId, amount). Defaults to false. */
  notifyPayee?: boolean;
  /**
   * Optional refund destination distinct from `payer` (the funder), for
   * sponsored escrows (docs/adr/0009). All refund paths — releaser and
   * timeout — pay this address, never the funder. Set once here under the
   * funder's signature and immutable afterwards. Omit to refund the
   * `payer`, exactly as in 0.3.x. Must not be the contract's own address
   * (rejected with `InvalidRefundTo`, error 21).
   */
  refundTo?: string;
  /** Earliest ledger timestamp at which release is allowed; omit for immediate release. */
  releaseNotBefore?: bigint;
}

export interface ReleaseOrRefundParams {
  escrowId: bigint;
  /**
   * Must be one of the escrow's `releasers` (set at creation) — see
   * docs/adr/0002. Only valid when the escrow's threshold is `1`; a
   * multi-signature escrow settles via `releaseWithApprovals` /
   * `refundWithApprovals`.
   */
  caller: Keypair;
}

/** Opens a dispute on a `Funded` escrow (Phase E6, docs/adr/0009). */
export interface RaiseDisputeParams {
  escrowId: bigint;
  /**
   * Must be the escrow's `payer`, `payee`, or one of its `releasers`. The
   * escrow moves to `Disputed`; `release`/`refund` are rejected until the
   * arbiter's split is settled.
   */
  caller: Keypair;
}

/** Records the arbiter's split for a `Disputed` escrow (Phase E6). */
export interface ResolveDisputeParams {
  escrowId: bigint;
  /** Must be the escrow's stored `arbiter`, and the escrow must be `Disputed`. */
  caller: Keypair;
  /** Basis points of `amount` returned to the payer (0..=10_000). */
  payerBps: number;
  /** Basis points of `amount` paid to the payee. `payerBps + payeeBps` must be 10_000. */
  payeeBps: number;
}

/** Settles a resolved dispute (Phase E6) by paying both recorded shares. */
export interface SettleParams {
  escrowId: bigint;
  /**
   * Pays the transaction fee. Settlement itself requires no contract auth —
   * the split was already authorised by the arbiter — so the escrow's funds
   * cannot get stuck behind a disappeared arbiter.
   */
  signer: Keypair;
}

/**
 * An action an address may take on an escrow right now, as reported by
 * `availableActions`.
 */
export type EscrowAction = "release" | "refund" | "raiseDispute" | "resolveDispute" | "settle";

/** Creation parameters for an M-of-N releaser escrow (docs/adr/0007). */
export interface CreateQuorumEscrowParams {
  /** Signs and pays for this call; funds are pulled from this account. */
  payer: Keypair;
  payee: string;
  token: string;
  amount: bigint;
  conditionRef: string;
  /**
   * The addresses that settle this escrow. Between 1 and `MAX_RELEASERS`
   * distinct addresses, stored immutably at creation — there is no setter
   * and no admin.
   */
  releasers: string[];
  /** How many of `releasers` must approve a settlement (at least 1). */
  threshold: number;
  /** See `CreateEscrowParams.refundAfter`. */
  refundAfter?: bigint;
  /** Opt a contract payee into `on_escrow_released`; requires payee authorization. */
  notifyPayee?: boolean;
  /** Optional refund destination distinct from `payer` (docs/adr/0009); defaults to `payer`. */
  refundTo?: string;
}

/** An M-of-N settlement: each keypair signs the contract auth entry. */
export interface SettlementApprovalsParams {
  escrowId: bigint;
  /**
   * The releasers approving this settlement. The first keypair also pays the
   * transaction fee; each of them signs the contract authorization entry, so
   * the list must not repeat a keypair. Without at least `threshold`
   * distinct approvers the contract rejects the call with `ThresholdNotMet`.
   */
  approvers: Keypair[];
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

// ---------------------------------------------------------------------------
// Fee estimation + sponsorship (issue #70)
// ---------------------------------------------------------------------------

/** A single contract invocation to estimate the fee of. */
export interface EstimateCallParams {
  /** Contract to invoke. Defaults to the client's configured `contractId`. */
  contractId?: string;
  /** Contract function name, e.g. `"create_escrow"`. */
  method: string;
  /** Already-encoded contract arguments (`xdr.ScVal[]`). */
  args?: xdr.ScVal[];
  /** Account that would sign and pay for the call. */
  source: Keypair;
}

/** Components of a simulated contract call's fee, in stroops. */
export interface FeeEstimate {
  /** Resource fee charged for CPU/memory/ledger entries, buffered for drift. */
  resourceFee: bigint;
  /** Inclusion fee: base fee × number of operations. */
  inclusionFee: bigint;
  /** `resourceFee + inclusionFee` — what the call is expected to cost. */
  total: bigint;
  /** The unbuffered resource fee the simulation reported. */
  minResourceFee: bigint;
}

export interface FeeBumpOptions {
  /**
   * Hard cap, in stroops, on the fee-bump transaction's fee. If the fee the
   * bump requires would exceed it, `feeBump` throws `MaxFeeExceededError`
   * instead of silently exceeding the cap.
   */
  maxFee: bigint;
  /** Base fee per operation for the wrapper, in stroops. Default: the network base fee (100). */
  baseFee?: bigint;
}

export interface FeeBumpResult {
  /** Signed fee-bump envelope, base64 XDR. */
  xdr: string;
  /** Fee the fee-bump transaction will charge, in stroops. */
  fee: bigint;
  /** Hash of the inner (sponsored) transaction — the one that actually executes. */
  innerTxHash: string;
}

/** Outcome of the sponsorship guard. */
export interface GuardResult {
  /** True only when every operation and contract-address auth entry targets the escrow contract. */
  ok: boolean;
  /** Human-readable rejection reasons, empty when `ok`. */
  reasons: string[];
  /** Every contract id the transaction invokes. */
  invokedContracts: string[];
}

/** Thrown when the sponsorship guard rejects a transaction. */
export class SponsorshipGuardError extends Error {
  readonly reasons: string[];
  constructor(reasons: string[]) {
    super(`Sponsorship guard rejected transaction: ${reasons.join("; ")}`);
    this.name = "SponsorshipGuardError";
    this.reasons = reasons;
  }
}

/** Thrown when a fee-bump would exceed the caller's `maxFee`. */
export class MaxFeeExceededError extends Error {
  readonly requestedFee: bigint;
  readonly maxFee: bigint;
  constructor(requestedFee: bigint, maxFee: bigint) {
    super(`Fee-bump requires ${requestedFee} stroops, above the maxFee cap of ${maxFee}`);
    this.name = "MaxFeeExceededError";
    this.requestedFee = requestedFee;
    this.maxFee = maxFee;
  }
}

/** Default headroom added to the simulated resource fee: 20% (2000 bps). */
export const DEFAULT_RESOURCE_FEE_BUFFER_BPS = 2_000;

/**
 * Pure fee arithmetic, split out so it can be unit-tested without an RPC.
 * The buffer is applied to the resource fee only (inclusion fee is already
 * deterministic) and rounds up, so an estimate is never a strop short.
 */
export function computeFeeEstimate(input: {
  minResourceFee: bigint;
  inclusionFee: bigint;
  bufferBps?: number;
}): FeeEstimate {
  const { minResourceFee, inclusionFee } = input;
  const bufferBps = input.bufferBps ?? DEFAULT_RESOURCE_FEE_BUFFER_BPS;
  if (minResourceFee < 0n) throw new RangeError("minResourceFee must not be negative.");
  if (inclusionFee < 0n) throw new RangeError("inclusionFee must not be negative.");
  if (!Number.isInteger(bufferBps) || bufferBps < 0) throw new RangeError("bufferBps must be a non-negative integer.");
  const resourceFee = (minResourceFee * BigInt(10_000 + bufferBps) + 9_999n) / 10_000n;
  return { resourceFee, inclusionFee, total: resourceFee + inclusionFee, minResourceFee };
}

/** Decode a contract address out of an `xdr.ScAddress`, or `undefined` for account addresses. */
function contractAddressOf(scAddress: xdr.ScAddress): string | undefined {
  if (scAddress.switch().name !== "scAddressTypeContract") return undefined;
  return Address.fromScAddress(scAddress).toString();
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
  private readonly archivalBehavior: ArchivedEntryBehavior;
  private readonly restoreSigner?: Keypair;

  constructor(config: EscrowClientConfig) {
    this.contractId = config.contractId;
    this.rpcUrl = config.rpcUrl ?? TESTNET_RPC_URL;
    this.networkPassphrase = config.networkPassphrase ?? TESTNET_NETWORK_PASSPHRASE;
    this.rpc = new RpcServer(this.rpcUrl);
    this.archivalBehavior = config.archivalBehavior ?? "error";
    this.restoreSigner = config.restoreSigner;
  }

  private contractClient(signer?: Keypair): EscrowContractClient {
    const effectiveSigner = signer ?? (this.archivalBehavior === "auto" ? this.restoreSigner : undefined);
    return new EscrowContractClient({
      contractId: this.contractId,
      rpcUrl: this.rpcUrl,
      networkPassphrase: this.networkPassphrase,
      ...(effectiveSigner ? { publicKey: effectiveSigner.publicKey(), signTransaction: effectiveSigner } : {}),
    });
  }

  /** Locks `amount` of `token` from `payer`, held for `payee`. Returns the new escrow's id and the funding transaction's hash. */
  async createEscrow(params: CreateEscrowParams): Promise<{ escrowId: bigint; txHash: string }> {
    if (params.conditionRef.length > MAX_CONDITION_REF_LENGTH) {
      throw new Error(
        `conditionRef must be at most ${MAX_CONDITION_REF_LENGTH} bytes, got ${params.conditionRef.length}`
      );
    }
    const client = this.contractClient(params.payer);
    const createParams = {
      payer: params.payer.publicKey(),
      payee: params.payee,
      token: params.token,
      amount: params.amount,
      condition_ref: params.conditionRef,
      releaser: params.releaser,
      refund_after: params.refundAfter,
      notify_payee: params.notifyPayee ?? false,
      refund_to: params.refundTo,
    };
    const tx = params.arbiter === undefined
      ? (params.releaseNotBefore === undefined
          ? await client.create_escrow(createParams)
          : await client.create_escrow_release_time({
              ...createParams,
              release_not_before: params.releaseNotBefore,
            }))
      : await client.create_escrow_with_arbiter({
          payer: params.payer.publicKey(),
          payee: params.payee,
          token: params.token,
          amount: params.amount,
          condition_ref: params.conditionRef,
          releaser: params.releaser,
          refund_after: params.refundAfter,
          arbiter: params.arbiter,
          notify_payee: params.notifyPayee ?? false,
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
   * Locks `amount` on behalf of an M-of-N releaser set (docs/adr/0007): the
   * escrow settles only with `threshold` distinct approvals from
   * `releasers`. Same validation and returned shape as `createEscrow`.
   */
  async createQuorumEscrow(
    params: CreateQuorumEscrowParams
  ): Promise<{ escrowId: bigint; txHash: string }> {
    if (params.conditionRef.length > MAX_CONDITION_REF_LENGTH) {
      throw new Error(
        `conditionRef must be at most ${MAX_CONDITION_REF_LENGTH} bytes, got ${params.conditionRef.length}`
      );
    }
    if (params.releasers.length === 0) {
      throw new Error("releasers must contain at least one address");
    }
    if (params.releasers.length > MAX_RELEASERS) {
      throw new Error(
        `releasers must contain at most ${MAX_RELEASERS} addresses, got ${params.releasers.length}`
      );
    }
    if (new Set(params.releasers).size !== params.releasers.length) {
      throw new Error("releasers must not contain duplicate addresses");
    }
    if (
      !Number.isInteger(params.threshold) ||
      params.threshold < 1 ||
      params.threshold > params.releasers.length
    ) {
      throw new Error(
        `threshold must be an integer between 1 and ${params.releasers.length}, got ${params.threshold}`
      );
    }
    const client = this.contractClient(params.payer);
    const tx = await client.create_escrow_with_releasers({
      payer: params.payer.publicKey(),
      payee: params.payee,
      token: params.token,
      amount: params.amount,
      condition_ref: params.conditionRef,
      releasers: params.releasers,
      threshold: params.threshold,
      refund_after: params.refundAfter,
      notify_payee: params.notifyPayee ?? false,
      refund_to: params.refundTo,
    });
    const sent = await tx.signAndSend();
    return { escrowId: sent.result.unwrap(), txHash: sent.sendTransactionResponse!.hash };
  }

  /**
   * Read-only: everything stored about `escrowId` — including the
   * `releasers` set, its `threshold` and `refundAfter`, which payees should
   * check before relying on a `Funded` escrow (docs/adr/0004, threat model
   * T8). Throws if `escrowId` doesn't exist.
   */
  async getEscrow(escrowId: bigint): Promise<Escrow> {
    const client = this.contractClient();
    const [tx, disputeTx] = await Promise.all([
      client.get_escrow({ escrow_id: escrowId }),
      client.get_dispute({ escrow_id: escrowId }),
    ]);
    const data = tx.result.unwrap();
    const dispute = disputeTx.result.unwrap();
    return {
      payer: data.payer,
      payee: data.payee,
      token: data.token,
      amount: data.amount,
      conditionRef: data.condition_ref,
      releasers: data.releasers,
      threshold: data.threshold,
      // The generated client decodes a contract `None` as `null`; the
      // public surface uses `undefined` for "no deadline" (consistent
      // with `CreateEscrowParams.refundAfter` being absent).
      refundAfter: data.refund_after ?? undefined,
      notifyPayee: data.notify_payee,
      // The generated client decodes a contract `None` as `null`.
      arbiter: dispute.arbiter ?? undefined,
      splitBps: dispute.resolved
        ? { payerBps: dispute.payer_bps, payeeBps: dispute.payee_bps }
        : undefined,
      refundTo: data.refund_to,
      releaseNotBefore: data.release_not_before ?? undefined,
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
   * Returns the escrow's funds to its `refundTo` (the payer unless a
   * sponsored escrow set another destination, docs/adr/0009). Normally `caller` must be
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

  /**
   * Opens a dispute on a `Funded` escrow (Phase E6, docs/adr/0009). Callable
   * by the payer, the payee, or any of the escrow's releasers; the escrow
   * moves to `Disputed` and direct `release`/`refund` calls are rejected
   * until the arbiter's split is settled. Returns the transaction's hash.
   */
  async raiseDispute(params: RaiseDisputeParams): Promise<{ txHash: string }> {
    const client = this.contractClient(params.caller);
    const tx = await client.raise_dispute({
      escrow_id: params.escrowId,
      caller: params.caller.publicKey(),
    });
    const sent = await tx.signAndSend();
    sent.result.unwrap();
    return { txHash: sent.sendTransactionResponse!.hash };
  }

  /**
   * Records the arbiter's split for a `Disputed` escrow as basis points of
   * the escrowed amount (Phase E6). Only the escrow's `arbiter` may call it,
   * once; `payerBps + payeeBps` must be 10_000. Recording moves no funds —
   * call `settle` afterwards. Returns the transaction's hash.
   */
  async resolveDispute(params: ResolveDisputeParams): Promise<{ txHash: string }> {
    for (const [name, bps] of [["payerBps", params.payerBps], ["payeeBps", params.payeeBps]] as const) {
      if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
        throw new RangeError(`${name} must be an integer between 0 and 10_000, got ${bps}`);
      }
    }
    if (params.payerBps + params.payeeBps !== 10_000) {
      throw new RangeError(
        `payerBps + payeeBps must equal 10_000, got ${params.payerBps + params.payeeBps}`
      );
    }
    const client = this.contractClient(params.caller);
    const tx = await client.resolve_dispute({
      escrow_id: params.escrowId,
      caller: params.caller.publicKey(),
      payer_bps: params.payerBps,
      payee_bps: params.payeeBps,
    });
    const sent = await tx.signAndSend();
    sent.result.unwrap();
    return { txHash: sent.sendTransactionResponse!.hash };
  }

  /**
   * Pays both sides of a resolved dispute from the recorded split (Phase E6).
   * Permissionless: `signer` only pays the fee, because the arbiter already
   * authorised the payout and it cannot be redirected. Throws if the arbiter
   * hasn't recorded a split yet. Returns the transaction's hash.
   */
  async settle(params: SettleParams): Promise<{ txHash: string }> {
    const client = this.contractClient(params.signer);
    const tx = await client.settle({ escrow_id: params.escrowId });
    const sent = await tx.signAndSend();
    sent.result.unwrap();
    return { txHash: sent.sendTransactionResponse!.hash };
  }

  /**
   * Estimates what a contract call will cost, in stroops, by simulating it
   * against the configured RPC. Nothing is signed or submitted.
   *
   * The resource fee carries a 20% buffer over the simulated minimum (rounded
   * up), because simulation can be a strop or two short of the real charge;
   * `minResourceFee` exposes the raw figure for callers that want their own
   * margin. Sponsors should treat `total` as the expected cost, not a promise
   * — fee-bump it with `maxFee` set to the most they are willing to pay.
   */
  async estimate(call: EstimateCallParams): Promise<FeeEstimate> {
    const contractId = call.contractId ?? this.contractId;
    const account = await this.rpc.getAccount(call.source.publicKey());
    const transaction = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract: contractId,
          function: call.method,
          args: call.args ?? [],
        }),
      )
      .setTimeout(30)
      .build();

    const simulation = await this.rpc.simulateTransaction(transaction);
    if (Api.isSimulationError(simulation)) {
      throw new Error(`Simulation failed for ${call.method}: ${simulation.error}`);
    }
    return computeFeeEstimate({
      minResourceFee: BigInt(simulation.minResourceFee),
      inclusionFee: BigInt(BASE_FEE) * BigInt(transaction.operations.length),
    });
  }

  /**
   * Wraps an already-signed transaction in a fee-bump paid by `sponsorSigner`.
   *
   * The wrapper's fee is `baseFee × (inner operations + 1)`, charged by the
   * fee-bump envelope; the cap is checked before anything is built, so a spike
   * either fits `maxFee` or throws `MaxFeeExceededError` — it is never silently
   * exceeded. Run `guardSponsorship` first when the inner transaction comes
   * from someone else.
   */
  feeBump(signedXdr: string, sponsorSigner: Keypair, options: FeeBumpOptions): FeeBumpResult {
    const inner = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase);
    if (!(inner instanceof Transaction)) {
      throw new TypeError("feeBump expects a regular signed transaction, not an already fee-bumped envelope.");
    }
    const baseFee = options.baseFee ?? BigInt(BASE_FEE);
    if (baseFee < 1n) throw new RangeError("baseFee must be at least 1 strop.");
    const maxFee = BigInt(options.maxFee);
    if (maxFee < 0n) throw new RangeError("maxFee must not be negative.");

    // A fee-bump envelope carries one operation (the wrapped inner tx), so it
    // costs baseFee × (inner ops + 1). The inner fee itself is refunded.
    const fee = baseFee * BigInt(inner.operations.length + 1);
    if (fee > maxFee) throw new MaxFeeExceededError(fee, maxFee);

    const bump = TransactionBuilder.buildFeeBumpTransaction(
      sponsorSigner,
      baseFee.toString(),
      inner,
      this.networkPassphrase,
    );
    bump.sign(sponsorSigner);
    return { xdr: bump.toXDR(), fee, innerTxHash: inner.hash().toString("hex") };
  }

  /**
   * Verifies that a transaction only touches this escrow contract before a
   * sponsor pays for it. Every operation is inspected, and so is every
   * contract-address auth entry — an invocation can otherwise smuggle in a
   * transfer authorized against another contract. Account-address auth entries
   * (the payer/releaser signatures) are expected and allowed.
   */
  guardSponsorship(signedXdr: string): GuardResult {
    const reasons: string[] = [];
    const invokedContracts = new Set<string>();

    let inner: Transaction | FeeBumpTransaction;
    try {
      inner = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase);
    } catch (error) {
      return {
        ok: false,
        reasons: [`could not decode transaction envelope: ${error instanceof Error ? error.message : String(error)}`],
        invokedContracts: [],
      };
    }
    // A fee-bump envelope is not sponsorable again; unwrap it so the inner
    // transaction is what gets judged (its hash is what executes).
    const transaction = inner instanceof FeeBumpTransaction ? inner.innerTransaction : inner;
    if (inner instanceof FeeBumpTransaction) {
      reasons.push("envelope is already a fee-bump transaction");
    }

    for (const operation of transaction.operations) {
      if (operation.type !== "invokeHostFunction") {
        reasons.push(`operation type "${operation.type}" is not a contract invocation`);
        continue;
      }
      const fn = operation.func;
      if (fn.switch().name !== "hostFunctionTypeInvokeContract") {
        reasons.push(`host function "${fn.switch().name}" is not a contract invocation`);
        continue;
      }
      const contractId = contractAddressOf(fn.invokeContract().contractAddress());
      if (!contractId) {
        reasons.push("contract invocation has no contract address");
        continue;
      }
      invokedContracts.add(contractId);
      if (contractId !== this.contractId) {
        reasons.push(`operation invokes foreign contract ${contractId}`);
      }

      for (const entry of operation.auth ?? []) {
        const credentials = entry.credentials();
        if (credentials.switch().name !== "sorobanCredentialsAddress") continue;
        const authContract = contractAddressOf(credentials.address().address());
        if (authContract && authContract !== this.contractId) {
          reasons.push(`auth entry targets foreign contract ${authContract}`);
        }
      }
    }

    if (transaction.operations.length === 0) reasons.push("transaction has no operations");
    return { ok: reasons.length === 0, reasons, invokedContracts: [...invokedContracts] };
  }

  /** Throws `SponsorshipGuardError` when `guardSponsorship` would reject. */
  assertSponsorable(signedXdr: string): void {
    const result = this.guardSponsorship(signedXdr);
    if (!result.ok) throw new SponsorshipGuardError(result.reasons);
  }

  /**
   * Releases an M-of-N escrow to its payee with at least `threshold`
   * distinct releaser approvals (docs/adr/0007). Each supplied keypair signs
   * the contract auth entry for this exact call; the first also pays the fee.
   * Returns the transaction's hash.
   */
  async releaseWithApprovals(params: SettlementApprovalsParams): Promise<{ txHash: string }> {
    return this.settleWithApprovals("release", params);
  }

  /**
   * Refunds an M-of-N escrow back to its payer with at least `threshold`
   * distinct releaser approvals (docs/adr/0007). The `refundAfter` timeout
   * path (`refund`) stays open to anyone and needs no approvals. Returns the
   * transaction's hash.
   */
  async refundWithApprovals(params: SettlementApprovalsParams): Promise<{ txHash: string }> {
    return this.settleWithApprovals("refund", params);
  }

  private async settleWithApprovals(
    settlement: "release" | "refund",
    params: SettlementApprovalsParams
  ): Promise<{ txHash: string }> {
    if (params.approvers.length === 0) {
      throw new Error("approvers must contain at least one releaser keypair");
    }
    const [invoker, ...additionalSigners] = params.approvers;
    const approverAddresses = params.approvers.map((approver) => approver.publicKey());
    if (new Set(approverAddresses).size !== approverAddresses.length) {
      throw new Error("approvers must not repeat a releaser keypair");
    }

    const client = this.contractClient(invoker);
    const tx = settlement === "release"
      ? await client.release_with_approvals({ escrow_id: params.escrowId, approvers: approverAddresses })
      : await client.refund_with_approvals({ escrow_id: params.escrowId, approvers: approverAddresses });
    for (const signer of additionalSigners) {
      await tx.signAuthEntries({ signAuthEntry: signer });
    }
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
      const eventName = nativeTopics.find((v) =>
        v === "created" || v === "released" || v === "refunded" ||
        v === "disputed" || v === "resolved" || v === "settled"
      ) as EscrowEventType | undefined;
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

/**
 * Pure mirror of the contract's transition rules: the actions `address` may
 * take on `escrow` at ledger time `now` (Phase E6). Never claims a call the
 * contract would reject if its inputs are accurate; conservative on time.
 *
 * **Ledger time, not the local clock.** `now` is compared against
 * `escrow.refundAfter`, which the contract evaluates against its own ledger
 * timestamp. Pass the latest ledger close time (from RPC or a recent
 * transaction), not `Date.now()`, or the answer can disagree by the
 * clock-skew margin.
 *
 * Quorum approvals (`releaseWithApprovals`/`refundWithApprovals`) are not
 * modelled: they need a set of signers rather than one address.
 */
export function availableActions(escrow: Escrow, address: string, now: bigint): EscrowAction[] {
  const actions: EscrowAction[] = [];
  const isPayer = address === escrow.payer;
  const isPayee = address === escrow.payee;
  const isReleaser = escrow.releasers.includes(address);
  const singleCaller = escrow.threshold === 1;

  switch (escrow.status) {
    case "Funded":
      if (isReleaser && singleCaller) actions.push("release");
      if ((isReleaser && singleCaller) || (escrow.refundAfter !== undefined && now >= escrow.refundAfter)) {
        actions.push("refund");
      }
      if (isPayer || isPayee || isReleaser) actions.push("raiseDispute");
      break;
    case "Disputed":
      if (address === escrow.arbiter && escrow.splitBps === undefined) actions.push("resolveDispute");
      if (escrow.splitBps !== undefined) actions.push("settle");
      break;
    case "Released":
    case "Refunded":
      break;
  }

  return actions;
}