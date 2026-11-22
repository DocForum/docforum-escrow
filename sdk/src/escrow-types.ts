import { type EscrowSigner } from "./signers/types.js";

/**
 * Length of `value` in UTF-8 bytes (not UTF-16 code units). Uses TextEncoder,
 * which is available in both browsers and Node.
 */
export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * The lifecycle state of an escrow, as returned by {@link EscrowClient.getStatus}
 * and carried on {@link Escrow.status}: `Funded` after creation, then `Released`
 * (paid to the payee), `Refunded` (returned to `refundTo`), or `Cancelled`.
 */
export type EscrowStatus = "Funded" | "Released" | "Refunded" | "Cancelled";

/** Arguments for {@link EscrowClient.extendRefundAfter}: both payer and releaser must sign. */
export interface ExtendRefundAfterParams {
  escrowId: bigint;
  /** New `refund_after`, unix seconds. Must be later than the current one. */
  newDeadline: bigint;
  /** The escrow's payer. Signs the transaction and pays the fee. */
  payer: EscrowSigner;
  /** The escrow's single releaser. Signs its own auth entry. */
  releaser: EscrowSigner;
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
  /**
   * Optional protocol-fee recipient, fixed at creation (docs/adr/0010).
   * Set together with `feeBps`; at release `feeBps` basis points of the
   * escrowed amount go here and the remainder to the payee. Refunds never
   * take a fee. `undefined` means no fee.
   */
  feeRecipient?: string;
  /**
   * Optional protocol-fee rate in basis points of the escrowed amount,
   * capped at 1 000 (10 %) and floored at release (docs/adr/0010). Must be
   * set together with `feeRecipient`.
   */
  feeBps?: number;
  /** Whether to call the contract payee's on_escrow_released hook. Defaults to false. */
  notifyPayee: boolean;
  /**
   * Where every refund (releaser or timeout) sends the funds. Fixed at
   * creation; equals `payer` unless a sponsored escrow set a different
   * destination (docs/adr/0009). Payees can read it to see who a
   * reversal would pay.
   */
  refundTo: string;
  /** Whether release waits for the payee's `accept` (issue #25). */
  requiresAcceptance: boolean;
  /** Ledger timestamp of the payee's acceptance; `undefined` until `accept`. */
  acceptedAt?: bigint;
  status: EscrowStatus;
}

/**
 * Maximum protocol-fee rate in basis points of the escrowed amount — must
 * match the contract's `MAX_FEE_BPS` (1 000 = 10 %, see docs/adr/0010).
 * Validated client-side so callers fail fast instead of paying network
 * fees for a rejected transaction. Keep in sync with the contract; a
 * change is an SDK semver event (hard rule 3).
 */
export const MAX_FEE_BPS = 1_000;

/**
 * Maximum allowed length of `conditionRef` in UTF-8 bytes (not UTF-16
 * code units) — must match the contract's bound (currently 64 bytes,
 * see contracts/escrow/src/lib.rs
 * and docs/threat-model.md T10). Validated client-side so callers fail
 * fast instead of paying network fees for a rejected transaction.
 *
 * Keep in sync with the contract: if the contract bound changes, update
 * this constant and bump the SDK's semver (hard rule 3).
 */
export const MAX_CONDITION_REF_LENGTH: number = 64;

/**
 * Maximum number of addresses in one escrow's releaser set — must match the
 * contract's `MAX_RELEASERS` (currently 10, see docs/adr/0007). Validated
 * client-side so callers fail fast instead of paying network fees for a
 * rejected transaction. Keep in sync with the contract; a change is an SDK
 * semver event (hard rule 3).
 */
export const MAX_RELEASERS = 10;

/** Parameters for {@link EscrowClient.createEscrow} — a single-releaser escrow. */
export interface CreateEscrowParams {
  /** Signs and pays for this call; funds are pulled from this account. */
  payer: EscrowSigner;
  /** Address the funds are released to on `release`. */
  payee: string;
  /** Address of the SEP-41 token contract to lock (e.g. the native XLM SAC). */
  token: string;
  /** Amount of `token` to lock, in the token's smallest unit. Must be positive. */
  amount: bigint;
  /** Opaque reference the contract stores but never interprets; at most {@link MAX_CONDITION_REF_LENGTH} UTF-8 bytes. */
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
  /**
   * Optional protocol fee, fixed at creation and taken at release
   * (docs/adr/0010). `feeRecipient` and `feeBps` are one atomic pair: give
   * both or neither, and `feeBps` may not exceed 1 000 (10 %). Omit both
   * for no fee — the payee then receives the full amount, as before.
   */
  feeRecipient?: string;
  /** Fee rate in basis points of the escrowed amount; see `feeRecipient`. */
  feeBps?: number;
  /**
   * Require the payee to `accept` before release (issue #25). Until they
   * do, the payer may `cancel`. Cannot be combined with `notifyPayee` or
   * `releaseNotBefore` (the contract has no such creation entry point).
   */
  requiresAcceptance?: boolean;
}

/** Parameters for {@link EscrowClient.cancel} — the payer cancels an unreleased escrow. */
export interface CancelParams {
  escrowId: bigint;
  /** The escrow's payer; signs the cancellation. */
  payer: EscrowSigner;
  /** See `LifecycleCallOptions.checkPreconditions`. Default `true`. */
  checkPreconditions?: boolean;
}

// ---------------------------------------------------------------------------
// Lifecycle amendments (issue #84): top-up, payee acceptance, payer cancel,
// plus a prepare → collect auth → submit flow for calls signed by parties
// on different machines.
// ---------------------------------------------------------------------------

/** Parameters for the single-releaser {@link EscrowClient.release} / {@link EscrowClient.refund} calls. */
export interface ReleaseOrRefundParams {
  /** The escrow to settle. */
  escrowId: bigint;
  /**
   * Must be one of the escrow's `releasers` (set at creation) — see
   * docs/adr/0002. Only valid when the escrow's threshold is `1`; a
   * multi-signature escrow settles via `releaseWithApprovals` /
   * `refundWithApprovals`.
   */
  caller: EscrowSigner;
}

/** Creation parameters for an M-of-N releaser escrow (docs/adr/0007). */
export interface CreateQuorumEscrowParams {
  /** Signs and pays for this call; funds are pulled from this account. */
  payer: EscrowSigner;
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
  approvers: EscrowSigner[];
}
