
// @docforum/escrow-sdk — ergonomic wrapper around the generated Soroban
// contract client (src/generated/contract-client.ts). Consumers (e.g.
// docforum-core's `payments` module — see its ARCHITECTURE.md ADR 0002)
// should import from here, not from src/generated/ directly.
//
// No PHI, no healthcare concepts here (hard rule 1) — types stay generic
// (payer/payee/amount, not e.g. "patient"). Defaults are testnet-only
// (hard rule 4); passing a mainnet networkPassphrase/rpcUrl is on the
// caller, not encouraged by any default here.
import { Keypair } from "@stellar/stellar-sdk";
import { Client as EscrowContractClient, type EscrowStatus as GeneratedEscrowStatus } from "./generated/contract-client.js";

export { Keypair };

/**
 * Basis-point denominator used by the contract for split payouts and the
 * protocol fee. Recipient splits must sum to exactly this value.
 */
export const BPS_DENOMINATOR = 10_000n;

/** Maximum number of recipients the contract accepts in a split payout. */
export const MAX_SPLIT_RECIPIENTS = 10;

/** One entry in a split payout: an address and its share in basis points. */
export interface SplitRecipient {
  /** Destination address (`G…`) that receives this share. */
  recipient: string;
  /** Share of the escrow amount, in basis points (1 bps = 0.01%). */
  bps: number;
}

/** Protocol fee applied to an escrow, in basis points. */
export type ProtocolFee = number;

export type EscrowStatus = "Funded" | "Released" | "Refunded";

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
  /**
   * Split payout recipients, in contract order. Empty when the escrow pays
   * a single `payee` (legacy behaviour). When non-empty, `payee` is unused
   * and funds are distributed per `previewPayout`.
   */
  splits: SplitRecipient[];
  /** Protocol fee in basis points applied to this escrow. */
  fee: ProtocolFee;
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
  /**
   * Optional split payout. When provided, must contain between 1 and
   * `MAX_SPLIT_RECIPIENTS` entries whose `bps` sum to exactly
   * `BPS_DENOMINATOR` (10,000). When omitted, funds go entirely to `payee`.
   */
  splits?: SplitRecipient[];
  /**
   * Optional protocol fee in basis points, in `[0, BPS_DENOMINATOR]`.
   * Deducted from the escrow amount before splits are applied.
   */
  fee?: ProtocolFee;
}

export interface ReleaseOrRefundParams {
  escrowId: bigint;
  /** Must be the escrow's `releaser` (set at creation) — see docs/adr/0002. */
  caller: Keypair;
}

/** A single recipient's computed payout, as returned by `previewPayout`. */
export interface PayoutShare {
  /** Destination address. */
  recipient: string;
  /** Exact amount this recipient receives, in token base units. */
  amount: bigint;
}

/** Result of `previewPayout`: per-recipient amounts plus the protocol fee. */
export interface PayoutPreview {
  /** Amount routed to each recipient, in contract order. */
  shares: PayoutShare[];
  /** Amount routed to the protocol fee collector. */
  feeAmount: bigint;
  /** Sum of `shares[].amount` plus `feeAmount`; equals the escrow amount. */
  total: bigint;
}

/** Thrown by client-side validation before any network call is made. */
export class EscrowValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EscrowValidationError";
  }
}

/**
 * Validates `splits` and `fee` against the contract's rules, throwing
 * `EscrowValidationError` with a message matching the contract's error.
 */
export function validateSplits(splits: SplitRecipient[] | undefined, fee: ProtocolFee | undefined): void {
  if (fee !== undefined) {
    if (!Number.isInteger(fee) || fee < 0 || BigInt(fee) > BPS_DENOMINATOR) {
      throw new EscrowValidationError("InvalidFee: fee must be an integer in [0, 10000] bps");
    }
  }
  if (splits === undefined) {
    return;
  }
  if (splits.length === 0) {
    throw new EscrowValidationError("EmptySplits: splits must contain at least one recipient");
  }
  if (splits.length > MAX_SPLIT_RECIPIENTS) {
    throw new EscrowValidationError(
      `TooManyRecipients: splits may contain at most ${MAX_SPLIT_RECIPIENTS} recipients`,
    );
  }
  let sum = 0n;
  for (const split of splits) {
    if (!Number.isInteger(split.bps) || split.bps < 0) {
      throw new EscrowValidationError("InvalidSplit: each split bps must be a non-negative integer");
    }
    sum += BigInt(split.bps);
  }
  if (sum !== BPS_DENOMINATOR) {
    throw new EscrowValidationError(
      `InvalidSplitSum: splits must sum to ${BPS_DENOMINATOR} bps (got ${sum})`,
    );
  }
}

/**
 * Computes per-recipient amounts for `escrow` using the contract's exact
 * rounding rule: the fee is floored first, then each split amount is
 * floored, and any rounding dust is added to the final recipient so the
 * shares always sum to the escrow amount minus the fee. Matches the Rust
 * implementation bit-for-bit (see shared test vectors).
 */
export function previewPayout(escrow: Escrow): PayoutPreview {
  const feeAmount = (escrow.amount * BigInt(escrow.fee)) / BPS_DENOMINATOR;
  const distributable = escrow.amount - feeAmount;
  const splits = escrow.splits.length > 0
    ? escrow.splits
    : [{ recipient: escrow.payee, bps: Number(BPS_DENOMINATOR) }];
  const shares: PayoutShare[] = [];
  let allocated = 0n;
  for (let i = 0; i < splits.length; i++) {
    const split = splits[i];
    const isLast = i === splits.length - 1;
    const amount = isLast
      ? distributable - allocated
      : (distributable * BigInt(split.bps)) / BPS_DENOMINATOR;
    allocated += amount;
    shares.push({ recipient: split.recipient, amount });
  }
  return { shares, feeAmount, total: escrow.amount };
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

  constructor(config: EscrowClientConfig) {
    this.contractId = config.contractId;
    this.rpcUrl = config.rpcUrl ?? TESTNET_RPC_URL;
    this.networkPassphrase = config.networkPassphrase ?? TESTNET_NETWORK_PASSPHRASE;
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
    validateSplits(params.splits, params.fee);
    const client = this.contractClient(params.payer);
    const tx = await client.create_escrow({
      payer: params.payer.publicKey(),
      payee: params.payee,
      token: params.token,
      amount: params.amount,
      condition_ref: params.conditionRef,
      releaser: params.releaser,
      refund_after: params.refundAfter,
      splits: params.splits?.map((s) => ({ recipient: s.recipient, bps: s.bps })),
      fee: params.fee,
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
      splits: (data.splits ?? []).map((s) => ({ recipient: s.recipient, bps: s.bps })),
      fee: data.fee ?? 0,
      status: data.status.tag,
    };
  }

  /** Read-only: previews per-recipient amounts for `escrowId` before funding. */
  async previewPayout(escrowId: bigint): Promise<PayoutPreview> {
    const escrow = await this.getEscrow(escrowId);
    return previewPayout(escrow);
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
}
