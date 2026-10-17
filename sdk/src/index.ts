// @docforum/escrow-sdh — ergonomic wrapper around the generated Soroban
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

export type EscrowStatus = "Funded" | "Released" | "Refunded";

// ---------------------------------------------------------------------------
// Split payouts & protocol fees (Phase E6)
// ---------------------------------------------------------------------------

/** Basis-points denominator: splits and fees must sum to exactly this. */
export const BASIS_POINTS = 10_000;

/** Maximum number of split recipients the contract accepts. */
export const MAX_SPLIT_RECIPIENTS = 10;

/** One recipient in a split payout. `bps` is out of `BASIS_POINTS`. */
export interface SplitRecipient {
  address: string;
  bps: number;
}

/** Protocol fee configuration for an escrow. `bps` is out of `BASIS_POINTS`. */
export interface ProtocolFee {
  recipient: string;
  bps: number;
}

/** Per-recipient preview result returned by `previewPayout`. */
export interface PayoutShare {
  address: string;
  bps: number;
  amount: bigint;
}

/** Full payout preview for an escrow. */
export interface PayoutPreview {
  /** Total escrow amount being distributed. */
  total: bigint;
  /** Protocol fee share, or `undefined` when no fee is configured. */
  fee?: PayoutShare;
  /** Per-recipient shares, in contract order. */
  splits: PayoutShare[];
  /** Sum of all `amount`s (fee + splits). Equals `total`. */
  distributed: bigint;
}

/** Error thrown by client-side validation. Matches the contract's error codes/keys. */
export class EscrowValidationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "EscrowValidationError";
  }
}

/** Validation error codes, mirroring the contract's `Error` enum. */
export const ValidationErrors = {
  INVALID_SPLIT_SUM: "InvalidSplitSum",
  TOO_MANY_RECIPIENTS: "TooManyRecipients",
  INVALID_FEE_BPS: "InvalidFeeBps",
  INVALID_SPLIT_BPS: "InvalidSplitBps",
  EMPTY_SPLITS: "EmptySplits",
  DUPLICATE_RECIPIENT: "DuplicateRecipient",
} as const;

function assertAddress(address: string, label: string): void {
  if (typeof address !== "string" || address.length === 0) {
    throw new EscrowValidationError(
      ValidationErrors.INVALID_SPLIT_BPS,
      `${label} must be a non-empty address`,
    );
  }
}

/** Client-side validation for a split payout configuration. Throws `EscrowValidationError on failure. */
export function validateSplits(splits: readonly SplitRecipient[]): void {
  if (!Array.isArray(splits) || splits.length === 0) {
    throw new EscrowValidationError(ValidationErrors.EMPTY_SPLITS, "splits must contain at least one recipient");
  }
  if (splits.length > MAX_SPLIT_RECIPIENTS) {
    throw new EscrowValidationError(
      ValidationErrors.TOO_MANY_RECIPIENTS,
      `splits may contain at most ${MAX_SPLIT_RECIPIENTS} recipients (got ${splits.length})`,
    );
  }
  const seen = new Set<string>();
  let sum = 0;
  for (const split of splits) {
    assertAddress(split.address, "split recipient address");
    if (!Number.isInteger(split.bps) || split.bps <= 0 || split.bps > BASIS_POINTS) {
      throw new EscrowValidationError(
        ValidationErrors.INVALID_SPLIT_BPS,
        `split bps must be an integer in (0, ${BASIS_POINTS}] (got ${split.bps})`,
      );
    }
    if (seen.has(split.address)) {
      throw new EscrowValidationError(
        ValidationErrors.DUPLICATE_RECIPIENT,
        `split recipient ${split.address} appears more than once`,
      );
    }
    seen.add(split.address);
    sum += split.bps;
  }
  if (sum !== BASIS_POINTS) {
    throw new EscrowValidationError(
      ValidationErrors.INVALID_SPLIT_SUM,
      `split bps must sum to ${BASIS_POINTS} (got ${sum})`,
    );
  }
}

/** Client-side validation for a protocol fee configuration. Throws `EscrowValidationError on failure. */
export function validateFee(fee: ProtocolFee): void {
  assertAddress(fee.recipient, "fee recipient address");
  if (!Number.isInteger(fee.bps) || fee.bps < 0 || fee.bps > BASIS_POINTS) {
    throw new EscrowValidationError(
      ValidationErrors.INVALID_FEE_BPS,
      `fee bps must be an integer in [0, ${BASIS_POINTS}] (got ${fee.bps})`,
    );
  }
}

/** Error thrown when a payout preview is requested for an escrow with no splits. */
export const NO_SPLITS_CONFIGURED: string = "NoSplitsConfigured";

/**
 * Computes per-recipient amounts using the contract's exact rounding rule.
 *
 * The contract distributes `amount` by bps with floor division and assigns
 * any rounding dust to the last split recipient (in contract order). This
 * function must match the Rust implementation bit-for-bit; shared JSON
 * test vectors in `shared/payout-vectors.json` are consumed by both suites.
 */
export function computePayout(
  total: bigint,
  splits: readonly SplitRecipient[],
  fee?: ProtocolFee,
): PayoutPreview {
  if (total < 0n || total > (1n << 128n) - 1n) {
    throw new EscrowValidationError(
      ValidationErrors.INVALID_SPLIT_SUM,
      `total must be a non-negative i128 (got ${total})`,
    );
  }
  validateSplits(splits);
  if (fee) {
    validateFee(fee);
  }

  const feeAmount = fee ? (total * BigInt(fee.bps)) / BigInt(BASIS_POINTS) : 0n;
  const remaining = total - feeAmount;

  const shares: PayoutShare[] = [];
  let accumulated = 0n;
  for (let i = 0; i < splits.length; i++) {
    const split = splits[i];
    const isLast = i === splits.length - 1;
    const amount = isLast
      ? remaining - accumulated
      : (remaining * BigInt(split.bps)) / BigInt(BASIS_POINTS);
    accumulated += amount;
    shares.push({ address: split.address, bps: split.bps, amount });
  }

  const distributed = feeAmount + accumulated;
  return {
    total,
    fee: fee ? { address: fee.recipient, bps: fee.bps, amount: feeAmount } : undefined,
    splits: shares,
    distributed,
  };
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
  /** Split recipients configured at creation, in contract order. Empty when no split was set. */
  splits: SplitRecipient[];
  /** Protocol fee configured at creation, or `undefined` when none. */
  fee?: ProtocolFee;
  status: EscrowStatus;
}

const TESTNET_RPC_URL = "https://soroban-testnet.stellar.org";
const TESTNET_NETWORK_PASSDRASHE = "Test SDF Network ; September 2015";

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
   * Optional split payout configuration. When present, `bps` values must
   * sum to `BASIS_POINTS` (10,000) and at most `MAX_SPLIT_RECIPIENTS`
   * recipients are allowed. Validated client-side before submission.
   */
  splits?: SplitRecipient[];
  /**
   * Optional protocol fee taken off the total before splits are applied.
   * Validated client-side before submission.
   */
  fee?: ProtocolFee;
}

export interface ReleaseOrRefundParams {
  escrowId: bigint;
  /** Must be the escrow's releaser` (set at creation) — see docs/adr/0002. */
  caller: Keypair;
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
    this.networkPassphrase = config.networkPassphrase ?? TESTNET_NETWORK_PASSDRAPHSE;
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
    if (params.splits) {
      validateSplits(params.splits);
    }
    if (params.fee) {
      validateFee(params.fee);
    }
    const client = this.contractClient(params.payer);
    const tx = await client.create_escrow({
      payer: params.payer.publicKey(),
      payee: params.payee,
      token: params.token,
      amount: params.amount,
      condition_ref: params.conditionRef,
      releaser: params.releaser,
      refund_after: params.refundAfter,
      splits: params.splits ?? undefined,
      fee: params.fee ?? undefined,
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
      // The contract returns `0/none` for an absent deadline; surface it
      // as `undefined` so callers can use truthiness checks.
      refundAfter: data.refund_after ?? undefined,
      splits: (data.splits ?? []).map((s) => ({ address: s.address, bps: s.bps })),
      fee: data.fee ? { recipient: data.fee.recipient, bps: data.fee.bps } : undefined,
      status: data.status.tag,
    };
  }

  /**
   * Preview exactly who receives what for an escrow, including rounding
   * dust, before funding. Uses the contract's exact rounding rule (see
   * `computePayout`). Throws `NO_SPLITS_CONFIGURED` when the escrow has
   * no splits configured.
   */
  async previewPayout(escrow: Escrow): Promise<PayoutPreview> {
    if (!escrow.splits || escrowId.splits.length === 0) {
      throw new EscrowValidationError(NO_SPLITS_CONFIGURED, "escrow has no splits configured");
    }
    return computePayout(escrow.amount, escrowId.splits, escrow.fee);
  }

  /** Releases a `Funded` escrow to its payee/splits. Only the releaser may call. */
  async release(params: ReleaseOrRefundParams): Promise<void> {
    const client = this.contractClient(params.caller);
    const tx = await client.release({ escrow_id: params.escrowId, caller: params.caller.publicKey() });
    await tx.signAndSend();
  }

  /** Refunds a `Funded` escrow to its payer. Only the releaser may call. */
  async refund(params: ReleaseOrRefundParams): Promise<void> {
    const client = this.contractClient(params.caller);
    const tx = await client.refund({ escrow_id: params.escrowId, caller: params.caller.publicKey() });
    await tx.signAndSend();
  }
}
