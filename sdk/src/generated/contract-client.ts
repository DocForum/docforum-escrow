import { Buffer } from "buffer";
import { Address } from "@stellar/stellar-sdk";
import {
  AssembledTransaction,
  Client as ContractClient,
  ClientOptions as ContractClientOptions,
  MethodOptions,
  Result,
  Spec as ContractSpec,
} from "@stellar/stellar-sdk/contract";
import type {
  u32,
  i32,
  u64,
  i64,
  u128,
  i128,
  u256,
  i256,
  Option,
  Timepoint,
  Duration,
} from "@stellar/stellar-sdk/contract";
export * from "@stellar/stellar-sdk";
export * as contract from "@stellar/stellar-sdk/contract";
export * as rpc from "@stellar/stellar-sdk/rpc";

if (typeof window !== "undefined") {
  //@ts-ignore Buffer exists
  window.Buffer = window.Buffer || Buffer;
}




export const Errors = {
  1: {message:"NotFound"},
  2: {message:"InvalidAmount"},
  3: {message:"Unauthorized"},
  4: {message:"NotFunded"},
  /**
   * `refund_after` was not strictly in the future at creation — see
   * docs/adr/0004: a deadline that has already passed would let
   * anyone refund the escrow before the releaser could ever act.
   */
  5: {message:"InvalidRefundAfter"},
  /**
   * The contract's token balance didn't rise by exactly `amount`
   * across `create_escrow`'s transfer (a lying or short-delivering
   * token) — see docs/threat-model.md T5.
   */
  6: {message:"BalanceMismatch"},
  /**
   * `condition_ref` exceeded the maximum allowed length (currently
   * 64 bytes) — see docs/threat-model.md T10 and ROADMAP.md Phase E5.
   * Bounded to keep storage and event costs predictable; reject at
   * creation so no on-chain storage is wasted on an oversized ref.
   */
  7: {message:"ConditionRefTooLong"},
  /**
   * `token` is not in the immutable deploy-time allowlist.
   */
  8: {message:"DisallowedToken"},
  /**
   * The opted-in payee callback returned an error or could not be
   * invoked. The release transaction (including its transfer) rolls back.
   */
  9: {message:"CallbackFailed"},
  /**
   * `new_payee` is invalid: it is either the contract's own address
   * or the payer's address. The contract address can never sign to
   * accept a payout; the payer is excluded so a payer cannot redirect
   * the release destination to themselves via a colluding payee.
   * Provisional code (issue #45 × 100); the maintainer fold assigns the
   * final number — see contract-changes.d/README.md.
   */
  4500: {message:"InvalidNewPayee"},
  12: {message:"Overflow"},
  /**
   * The releaser set is empty, or `threshold` is 0 or larger than the
   * number of releasers — see docs/adr/0007.
   */
  13: {message:"InvalidThreshold"},
  /**
   * More than `MAX_RELEASERS` (10) addresses were supplied at creation.
   */
  14: {message:"TooManyReleasers"},
  /**
   * Fewer distinct approvals were supplied than the escrow's threshold,
   * or a single releaser tried to settle a quorum escrow through the
   * single-caller entry point.
   */
  15: {message:"ThresholdNotMet"},
  /**
   * The same address appeared twice in one approval list. Duplicates
   * never count twice toward the threshold.
   */
  16: {message:"DuplicateApprover"},
  /**
   * The same address appeared twice in the releaser set at creation.
   */
  17: {message:"DuplicateReleaser"},
  18: {message:"AcceptanceRequired"},
  19: {message:"AcceptanceNotConfigured"},
  20: {message:"AlreadyAccepted"},
  /**
   * The new releaser cannot be the escrow contract or payee.
   */
  24: {message:"InvalidReleaser"},
  /**
   * `refund_to` was the escrow contract's own address — funds sent
   * there on refund could never be moved again (docs/adr/0009).
   */
  21: {message:"InvalidRefundTo"},
  /**
   * The configured release time is in the past or after the refund time.
   */
  22: {message:"InvalidReleaseNotBefore"},
  /**
   * Release was attempted before the configured time.
   */
  23: {message:"ReleaseTooEarly"},
  /**
   * A batch call was passed more than `MAX_BATCH_SIZE` items — see
   * docs/adr/0005. Callers must chunk. Appended at the end so existing
   * discriminants keep their on-chain values.
   */
  25: {message:"BatchTooLarge"},
  /**
   * `contribute`/`claim_refund`/`get_contribution` on a non-pooled
   * escrow, or `get_pooled` on a non-pooled/unknown id — see
   * docs/adr/0011.
   */
  26: {message:"NotPooled"},
  /**
   * A contribution arrived after the pooled escrow's funding deadline.
   * Late contributions can never be accepted: the round's outcome
   * (release vs per-contributor refunds) is fixed at the deadline.
   */
  27: {message:"FundingDeadlinePassed"},
  /**
   * A contribution would push the pooled total past the funding target
   * (overfunding is rejected, not accepted), the target is already met,
   * or a refund was claimed on a fully funded pooled escrow.
   */
  28: {message:"FundingTargetReached"},
  /**
   * `release` on a pooled escrow whose funded total is below the
   * funding target — partial funding is never releasable.
   */
  29: {message:"FundingIncomplete"},
  /**
   * `claim_refund` before the funding deadline passed on a round that
   * is still (or now fully) funded. Claims open only for a failed round.
   */
  30: {message:"RefundNotOpen"},
  /**
   * The same contributor tried to claim a refund twice.
   */
  31: {message:"AlreadyRefunded"},
  /**
   * `claim_refund` by an address with no recorded contribution.
   */
  32: {message:"NoContribution"},
  /**
   * `refund`/`refund_with_approvals`/`cancel`/`top_up` on a pooled
   * escrow: pushing the whole pooled total to one address would violate
   * per-contributor accounting. Pooled refunds are pull-based
   * (`claim_refund`); pooled funding is `contribute`-only.
   */
  33: {message:"NotSupportedForPooled"},
  /**
   * The funding deadline was not strictly in the future at creation.
   */
  34: {message:"InvalidFundingDeadline"},
  /**
   * The optional protocol fee was misconfigured at creation: `bps`
   * above [`MAX_FEE_BPS`] (10 %), a recipient equal to the escrow
   * contract itself, or an amount that would overflow the fee math —
   * see docs/adr/0010.
   */
  35: {message:"InvalidFee"},
  /**
   * An outbound release transfer failed; the funded escrow remains
   * retryable and may still use its refund path.
   */
  36: {message:"Undeliverable"}
}


/**
 * One entry of a `create_escrows` batch. Mirrors the single-escrow
 * creation parameters minus the batch-wide `payer`.
 */
export interface CreateItem {
  amount: i128;
  condition_ref: string;
  payee: string;
  refund_after: Option<u64>;
  releaser: string;
  token: string;
}


export interface EscrowData {
  /**
 * Ledger timestamp at which the payee accepted, if any.
 */
accepted_at: Option<u64>;
  amount: i128;
  /**
 * Opaque caller-supplied reference the contract stores but never
 * interprets (docs/adr/0001). This field is **public on-chain forever**,
 * like the rest of `EscrowData` (docs/threat-model.md T9): never put
 * private, personal or sensitive data here. Pass an opaque, meaningless
 * id such as a UUID or an internal record id.
 */
condition_ref: string;
  /**
 * Fee rate in basis points of `amount` (capped at [`MAX_FEE_BPS`]
 * = 10 %), taken once at release, rounded **down** with the
 * remainder to the payee — see docs/adr/0010.
 */
fee_bps: Option<u32>;
  /**
 * Optional protocol fee recipient, set once at `create_escrow` time
 * and paid at release (never on refund) — see docs/adr/0010. Stored
 * as one (recipient, bps) pair in two fields so both are always set
 * together or not at all (creation-time rule, `InvalidFee`
 * otherwise). `None` (with no bps) means no fee: the payee receives
 * the full `amount`, exactly as before this field existed.
 */
fee_recipient: Option<string>;
  /**
 * If true, invoke the contract payee's `on_escrow_released` hook after
 * the payout transfer. A failed callback reverts the whole release.
 */
notify_payee: boolean;
  payee: string;
  /**
 * The funder: authorises and pays for the escrow at creation. Also
 * the refund destination unless `refund_to` says otherwise.
 */
payer: string;
  /**
 * Optional deadline (unix seconds) after which `refund` opens to
 * anyone — still only to `refund_to`. `None` means no timeout,
 * behaviour identical to before this field existed — see docs/adr/0004.
 */
refund_after: Option<u64>;
  /**
 * Where **every** refund path (releaser, timeout) sends the funds.
 * Fixed at creation under the funder's auth and never chosen at
 * payout, so invariant I1 holds; defaults to `payer` when omitted at
 * creation — see docs/adr/0009.
 */
refund_to: string;
  /**
 * Earliest ledger timestamp at which release is allowed.
 */
release_not_before: Option<u64>;
  /**
 * Addresses permitted to settle this escrow — see docs/adr/0002 for the
 * per-escrow releaser, and docs/adr/0007 for M-of-N sets. A plain
 * single-releaser escrow stores exactly one entry here.
 */
releasers: Array<string>;
  /**
 * Whether release requires the payee's explicit acceptance.
 */
requires_acceptance: boolean;
  status: EscrowStatus;
  /**
 * How many *distinct* addresses from `releasers` must authorize one
 * settlement. Always `>= 1` and `<= releasers.len()`; `1` means any
 * single releaser can settle (the pre-quorum behaviour).
 */
threshold: u32;
  token: string;
}


/**
 * One entry of a `create_escrows` batch. Mirrors the single-escrow
 * creation parameters minus the batch-wide `payer`.
 * Immutable funding configuration of a pooled escrow (issue #113,
 * docs/adr/0011). Existence of this record under `DataKey::Pooled(id)` is
 * what makes an escrow "pooled"; the aggregate funded amount lives in
 * `EscrowData.amount` (one source of truth shared with `settle()`).
 */
export interface PooledData {
  /**
 * Unix seconds until which `contribute` is accepted. When it passes
 * with the target unmet, the round has failed: contributions are
 * frozen forever and every contributor may pull their exact recorded
 * amount back with `claim_refund` — the escrow can never be released.
 */
funding_deadline: u64;
  /**
 * Total the contributors must reach for release to become possible.
 * Strictly positive, fixed at creation, never changed afterwards.
 */
funding_target: i128;
}


/**
 * One payer's record on a pooled escrow (issue #113, docs/adr/0011).
 * `amount` accumulates every accepted contribution from that payer;
 * `refunded` is the claim-completion marker that makes a second payout
 * impossible. Records are only ever written by `contribute` and
 * `claim_refund`, each under the contributor's own authorization.
 */
export interface Contribution {
  amount: i128;
  refunded: boolean;
}

export type EscrowStatus = {tag: "Funded", values: void} | {tag: "Released", values: void} | {tag: "Refunded", values: void} | {tag: "Cancelled", values: void};

/**
 * What one `settle_many` operation does to its escrow (issue #29).
 */
export type SettleAction = {tag: "Release", values: void} | {tag: "Refund", values: void};


export interface Client {
  /**
   * Construct and simulate a accept transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Records the payee's acceptance for an opted-in funded escrow.
   */
  accept: ({escrow_id, payee}: {escrow_id: u64, payee: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a cancel transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Lets the payer take the funds back **before the payee accepts**
   * (docs/adr/0010): returns the escrowed `amount` to `refund_to` (the
   * `payer` unless a sponsor destination was fixed at creation, ADR
   * 0009) and marks the escrow `Cancelled`. Allowed only while **all**
   * hold:
   * 
   * - `payer` is the escrow's stored payer and authorizes the call;
   * - the escrow is still `Funded` (`NotFunded` otherwise — never after
   * a release, refund or earlier cancel);
   * - it was created with `requires_acceptance`
   * (`AcceptanceNotConfigured` otherwise — without the gate there is
   * no acceptance step to race, so no cancel window exists);
   * - the payee has not accepted (`AlreadyAccepted` otherwise).
   * 
   * The destination is read from storage, so invariant I1 is unchanged.
   * Payees: do not rely on a `requires_acceptance` escrow until you
   * have called `accept`. `accept` and `cancel` race on one ledger
   * state: whichever lands first wins and the other fails.
   */
  cancel: ({escrow_id, payer}: {escrow_id: u64, payer: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a refund transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the escrowed `amount` to the escrow's `refund_to` (the
   * `payer` unless a different destination was fixed at creation —
   * docs/adr/0006). Same state rule as
   * `release` (only while `Funded`), but two callers are authorised:
   * 
   * - the escrow's releaser (docs/adr/0002), always; or
   * - **anyone**, once `refund_after` has been reached — the timeout
   * refund path for a lost/unsignable releaser key (docs/adr/0004).
   * 
   * The destination never changes: timeout or not, funds only ever go
   * to the stored `refund_to`, which no caller can influence. With no
   * `refund_after` set, behaviour is identical to before the timeout
   * existed — releaser only. On an M-of-N escrow the releaser path needs
   * a threshold of 1; otherwise use `refund_with_approvals` (the timeout
   * path stays open to anyone). The stored payee may also voluntarily
   * refund a funded escrow; that path emits `payee_refunded` (ADR 0010).
   * A protocol fee is never taken on the refund path.
   */
  refund: ({escrow_id, caller}: {escrow_id: u64, caller: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a top_up transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Adds funds to a funded escrow without changing its parties or id.
   * Only its original payer may authorize the transfer.
   */
  top_up: ({escrow_id, payer, amount}: {escrow_id: u64, payer: string, amount: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a release transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Moves the escrowed `amount` to `payee`. Only the escrow's releaser
   * may call this — the contract enforces WHO, never WHY (ADR 0001). On
   * an M-of-N escrow this single-caller path is only allowed when the
   * threshold is 1; otherwise use `release_with_approvals`.
   * 
   * Deliberately **not** gated by `refund_after` (docs/adr/0004): after
   * the deadline the releaser can still release, racing any timeout
   * refund — whoever lands first wins and the other fails `NotFunded`.
   * 
   * If the escrow was created with a fee (docs/adr/0010), the fee comes
   * off the top — `⌊amount × fee_bps ÷ 10 000⌋` goes to `fee_recipient`,
   * the exact remainder to `payee`, so the two transfers always sum to
   * the escrowed `amount`. No fee is ever taken on `refund`.
   */
  release: ({escrow_id, caller}: {escrow_id: u64, caller: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a version transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Semantic version of this contract interface and behavior.
   * Build provenance is available separately in the WASM contract
   * metadata (`git_sha` and `soroban_sdk_version`).
   */
  version: (options?: MethodOptions) => Promise<AssembledTransaction<string>>

  /**
   * Construct and simulate a solvency transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Read-only solvency check for one token (issue #39): returns
   * `(balance, liabilities)`, where `balance` is this contract's current
   * balance of `token` and `liabilities` is the sum of `amount` over
   * every escrow in `token` that is still `Funded` (pooled escrows count
   * their funded total net of claimed refunds). The contract is solvent
   * for `token` exactly when `balance >= liabilities`.
   * 
   * `liabilities` is maintained on-chain by every state change that
   * moves value — creation, `top_up` and `contribute` add, and
   * release/refund/cancel/`claim_refund` subtract — in the same
   * invocation, so it can never drift from the escrows themselves.
   * A token never used by this contract reports `0` liabilities.
   */
  solvency: ({token}: {token: string}, options?: MethodOptions) => Promise<AssembledTransaction<readonly [i128, i128]>>

  /**
   * Construct and simulate a contribute transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Adds `amount` to a pooled escrow from `payer` (issue #113,
   * docs/adr/0011). Permissionless — anyone may fund — but every
   * contribution:
   * - must be a positive amount (`InvalidAmount`);
   * - is accepted only while the escrow is `Funded` and the ledger
   * timestamp is strictly before the funding deadline
   * (`FundingDeadlinePassed` after it — late money can never change a
   * round's outcome);
   * - may not push the pooled total past the funding target
   * (`FundingTargetReached` — overfunding is rejected, not refunded);
   * - is pulled from `payer` under `payer.require_auth()` and verified
   * with the same exact balance-delta check as creation
   * (`BalanceMismatch` if the contract's balance didn't rise by
   * exactly `amount`);
   * - is recorded against `payer` only, accumulating across repeated
   * contributions and never touching other payers' records.
   * Accounting is updated only after the transfer is verified, so a
   * failed contribution records nothing (invariant I4).
   */
  contribute: ({escrow_id, payer, amount}: {escrow_id: u64, payer: string, amount: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a get_escrow transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Read-only accessor for everything stored about `escrow_id` — payer,
   * payee, token, amount, `condition_ref`, status, the releaser set with
   * its threshold, `refund_after`, `refund_to` and the optional fee
   * (`fee_recipient`/`fee_bps`, exactly as declared at creation). Exists
   * so payees and integrators can check who can settle, when, where a
   * refund goes and the exact fee before relying on a `Funded` escrow
   * (docs/adr/0004, threat model T8; docs/adr/0010). Errors on an
   * unknown id.
   */
  get_escrow: ({escrow_id}: {escrow_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<EscrowData>>>

  /**
   * Construct and simulate a get_pooled transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Read-only: the immutable funding config of a pooled escrow. The
   * aggregate funded amount is the escrow's `amount` from `get_escrow`;
   * a round is failed when `now >= funding_deadline` and `amount <
   * funding_target` (then `claim_refund` is open to each contributor).
   * Errors `NotPooled` on a non-pooled or unknown id.
   */
  get_pooled: ({escrow_id}: {escrow_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<PooledData>>>

  /**
   * Construct and simulate a get_status transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Read-only status query. Errors if `escrow_id` doesn't exist.
   */
  get_status: ({escrow_id}: {escrow_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<EscrowStatus>>>

  /**
   * Construct and simulate a settle_many transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Settles many escrows in one transaction (issue #29, docs/adr/0012) —
   * the fast path for threat model T1's "race the attacker" response and
   * for high-volume integrators. Each `(escrow_id, action)` is checked
   * exactly like the single-escrow entry point it mirrors:
   * 
   * - `Release`: `caller` must be a releaser of that escrow with
   * threshold 1, the escrow must be `Funded`, a pooled escrow must be
   * fully funded, and `release_not_before`/payee acceptance apply.
   * - `Refund`: pooled escrows are rejected; `caller` must be a releaser
   * (threshold 1) unless `refund_after` has passed, in which case
   * anyone may refund — always to the stored `refund_to`.
   * 
   * `caller` authorizes the whole batch once. Per-op authority comes
   * only from each escrow's own stored releaser set, so a batch can never
   * settle an escrow whose releaser is someone else: that op returns
   * `Unauthorized` and touches nothing.
   * 
   * **Best-effort with per-op results:** the returned vector has one
   * entry per input op, in input order. `Ok(())` means that escrow was
   * settled by thi
   */
  settle_many: ({caller, ops}: {caller: string, ops: Array<readonly [u64, SettleAction]>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Array<Result<void>>>>>

  /**
   * Construct and simulate a claim_refund transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Pull-based refund (issue #113, docs/adr/0011): pays `contributor`
   * exactly the amount recorded against that address, once. Available
   * only for a *failed* funding round — the funding deadline has passed
   * with the pooled total still below the target (`RefundNotOpen`
   * otherwise) — and only while the escrow has not been released
   * (`NotFunded` afterwards: released funds can never be claimed).
   * Each claim is O(1) work — no path iterates contributors — and its
   * own authorization: no one can claim on another contributor's
   * behalf (`NoContribution` for an address with no record), a second
   * claim fails `AlreadyRefunded`, and the order of claims can never
   * change anyone's entitlement. Checks-effects-interactions: the
   * `refunded` flag and the pooled total are written before the
   * transfer, and a failing transfer rolls the whole claim back.
   */
  claim_refund: ({escrow_id, contributor}: {escrow_id: u64, contributor: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a create_escrow transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Locks `amount` of `token` pulled from `payer`, held for `payee`,
   * docs/threat-model.md T10 and ROADMAP.md Phase E5). `releaser` is the
   * address permitted to call `release`/`refund` on this escrow
   * (docs/adr/0002). `refund_after` is optional (docs/adr/0004).
   * `notify_payee` opts an implementing contract payee into
   * `on_escrow_released(escrow_id, amount)` (docs/adr/0005). The payer
   * must authorize creation, and the payee must also authorize if
   * `notify_payee` is true. `refund_to` is the optional refund
   * destination for a sponsored escrow where the funder (`payer`) is
   * not who should get the money back (docs/adr/0009): `None` means
   * `payer`; it may not be this contract's own address, and the
   * `payer`'s auth on this call covers it. `condition_ref` is stored
   * verbatim and is public on-chain forever (docs/threat-model.md T9):
   * pass an opaque id, never private or personal data. For M-of-N
   * releasers use `create_escrow_with_releasers`.
   */
  create_pooled_escrow: ({creator, payee, token, funding_target, condition_ref, releaser, funding_deadline}: {creator: string, payee: string, token: string, funding_target: i128, condition_ref: string, releaser: string, funding_deadline: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a refund_with_approvals transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the escrowed `amount` to `refund_to` on behalf of an M-of-N
   * releaser set (docs/adr/0007). Same approval rules as
   * `release_with_approvals`. The timeout refund path in `refund` stays
   * available as well: once `refund_after` passes, anyone can return the
   * funds to the payer without approvals.
   */
  refund_with_approvals: ({escrow_id, approvers}: {escrow_id: u64, approvers: Array<string>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a release_with_approvals transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Moves the escrowed `amount` to `payee` on behalf of an M-of-N
   * releaser set (docs/adr/0007). Every address in `approvers` must be a
   * releaser, appear at most once, and authorize this exact invocation;
   * at least `threshold` distinct approvers are required. Approvals are
   * not stored between calls, so there is nothing to clear on settlement
   * and no approval to replay — a settled escrow fails `NotFunded`.
   */
  release_with_approvals: ({escrow_id, approvers}: {escrow_id: u64, approvers: Array<string>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a create_escrow_release_time transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Creates a single-releaser escrow with an optional earliest release time.
   * Release is allowed at the configured timestamp. Accepts the same
   * optional `fee_recipient`/`fee_bps` pair as `create_escrow`
   * (docs/adr/0010).
   */
  create_escrow_release_time: ({payer, payee, token, amount, condition_ref, releaser, refund_after, notify_payee, refund_to, release_not_before, fee_recipient, fee_bps}: {payer: string, payee: string, token: string, amount: i128, condition_ref: string, releaser: string, refund_after: Option<u64>, notify_payee: boolean, refund_to: Option<string>, release_not_before: Option<u64>, fee_recipient: Option<string>, fee_bps: Option<u32>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a create_escrow_with_releasers transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Same as `create_escrow`, but the escrow is settled by M-of-N
   * releasers instead of one address (docs/adr/0007): `threshold`
   * distinct addresses from `releasers` must authorize a settlement.
   * The set is stored at creation and cannot be changed afterwards —
   * there is no admin and no setter. Rejects an empty set, more than
   * 10 releasers, duplicate addresses, and a threshold of 0 or one
   * larger than the set.
   */
  create_escrow_with_releasers: ({payer, payee, token, amount, condition_ref, releasers, threshold, refund_after, notify_payee, refund_to}: {payer: string, payee: string, token: string, amount: i128, condition_ref: string, releasers: Array<string>, threshold: u32, refund_after: Option<u64>, notify_payee: boolean, refund_to: Option<string>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a create_escrow_with_acceptance transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Creates an escrow with an opt-in payee acceptance gate. Existing
   * integrations can keep using `create_escrow`, which defaults this off.
   */
  create_escrow_with_acceptance: ({payer, payee, token, amount, condition_ref, releaser, refund_after, requires_acceptance, refund_to}: {payer: string, payee: string, token: string, amount: i128, condition_ref: string, releaser: string, refund_after: Option<u64>, requires_acceptance: boolean, refund_to: Option<string>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

}
export class Client extends ContractClient {
  static async deploy<T = Client>(
        /** Constructor/Initialization Args for the contract's `__constructor` method */
        {allowed_tokens}: {allowed_tokens: Array<string>},
    /** Options for initializing a Client as well as for calling a method, with extras specific to deploying. */
    options: MethodOptions &
      Omit<ContractClientOptions, "contractId"> & {
        /** The hash of the Wasm blob, which must already be installed on-chain. */
        wasmHash: Buffer | string;
        /** Salt used to generate the contract's ID. Passed through to {@link Operation.createCustomContract}. Default: random. */
        salt?: Buffer | Uint8Array;
        /** The format used to decode `wasmHash`, if it's provided as a string. */
        format?: "hex" | "base64";
      }
  ): Promise<AssembledTransaction<T>> {
    return ContractClient.deploy({allowed_tokens}, options)
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([ "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAAFQAAAAAAAAAITm90Rm91bmQAAAABAAAAAAAAAA1JbnZhbGlkQW1vdW50AAAAAAAAAgAAAAAAAAAMVW5hdXRob3JpemVkAAAAAwAAAAAAAAAJTm90RnVuZGVkAAAAAAAABAAAALpgcmVmdW5kX2FmdGVyYCB3YXMgbm90IHN0cmljdGx5IGluIHRoZSBmdXR1cmUgYXQgY3JlYXRpb24g4oCUIHNlZQpkb2NzL2Fkci8wMDA0OiBhIGRlYWRsaW5lIHRoYXQgaGFzIGFscmVhZHkgcGFzc2VkIHdvdWxkIGxldAphbnlvbmUgcmVmdW5kIHRoZSBlc2Nyb3cgYmVmb3JlIHRoZSByZWxlYXNlciBjb3VsZCBldmVyIGFjdC4AAAAAABJJbnZhbGlkUmVmdW5kQWZ0ZXIAAAAAAAUAAACjVGhlIGNvbnRyYWN0J3MgdG9rZW4gYmFsYW5jZSBkaWRuJ3QgcmlzZSBieSBleGFjdGx5IGBhbW91bnRgCmFjcm9zcyBgY3JlYXRlX2VzY3Jvd2AncyB0cmFuc2ZlciAoYSBseWluZyBvciBzaG9ydC1kZWxpdmVyaW5nCnRva2VuKSDigJQgc2VlIGRvY3MvdGhyZWF0LW1vZGVsLm1kIFQ1LgAAAAAPQmFsYW5jZU1pc21hdGNoAAAAAAYAAAEAYGNvbmRpdGlvbl9yZWZgIGV4Y2VlZGVkIHRoZSBtYXhpbXVtIGFsbG93ZWQgbGVuZ3RoIChjdXJyZW50bHkKNjQgYnl0ZXMpIOKAlCBzZWUgZG9jcy90aHJlYXQtbW9kZWwubWQgVDEwIGFuZCBST0FETUFQLm1kIFBoYXNlIEU1LgpCb3VuZGVkIHRvIGtlZXAgc3RvcmFnZSBhbmQgZXZlbnQgY29zdHMgcHJlZGljdGFibGU7IHJlamVjdCBhdApjcmVhdGlvbiBzbyBubyBvbi1jaGFpbiBzdG9yYWdlIGlzIHdhc3RlZCBvbiBhbiBvdmVyc2l6ZWQgcmVmLgAAABNDb25kaXRpb25SZWZUb29Mb25nAAAAAAcAAAA2YHRva2VuYCBpcyBub3QgaW4gdGhlIGltbXV0YWJsZSBkZXBsb3ktdGltZSBhbGxvd2xpc3QuAAAAAAAPRGlzYWxsb3dlZFRva2VuAAAAAAgAAACDVGhlIG9wdGVkLWluIHBheWVlIGNhbGxiYWNrIHJldHVybmVkIGFuIGVycm9yIG9yIGNvdWxkIG5vdCBiZQppbnZva2VkLiBUaGUgcmVsZWFzZSB0cmFuc2FjdGlvbiAoaW5jbHVkaW5nIGl0cyB0cmFuc2Zlcikgcm9sbHMgYmFjay4AAAAADkNhbGxiYWNrRmFpbGVkAAAAAAAJAAAAAAAAAAhPdmVyZmxvdwAAAAwAAABsVGhlIHJlbGVhc2VyIHNldCBpcyBlbXB0eSwgb3IgYHRocmVzaG9sZGAgaXMgMCBvciBsYXJnZXIgdGhhbiB0aGUKbnVtYmVyIG9mIHJlbGVhc2VycyDigJQgc2VlIGRvY3MvYWRyLzAwMDcuAAAAEEludmFsaWRUaHJlc2hvbGQAAAANAAAAQ01vcmUgdGhhbiBgTUFYX1JFTEVBU0VSU2AgKDEwKSBhZGRyZXNzZXMgd2VyZSBzdXBwbGllZCBhdCBjcmVhdGlvbi4AAAAAEFRvb01hbnlSZWxlYXNlcnMAAAAOAAAAn0Zld2VyIGRpc3RpbmN0IGFwcHJvdmFscyB3ZXJlIHN1cHBsaWVkIHRoYW4gdGhlIGVzY3JvdydzIHRocmVzaG9sZCwKb3IgYSBzaW5nbGUgcmVsZWFzZXIgdHJpZWQgdG8gc2V0dGxlIGEgcXVvcnVtIGVzY3JvdyB0aHJvdWdoIHRoZQpzaW5nbGUtY2FsbGVyIGVudHJ5IHBvaW50LgAAAAAPVGhyZXNob2xkTm90TWV0AAAAAA8AAABoVGhlIHNhbWUgYWRkcmVzcyBhcHBlYXJlZCB0d2ljZSBpbiBvbmUgYXBwcm92YWwgbGlzdC4gRHVwbGljYXRlcwpuZXZlciBjb3VudCB0d2ljZSB0b3dhcmQgdGhlIHRocmVzaG9sZC4AAAARRHVwbGljYXRlQXBwcm92ZXIAAAAAAAAQAAAAQFRoZSBzYW1lIGFkZHJlc3MgYXBwZWFyZWQgdHdpY2UgaW4gdGhlIHJlbGVhc2VyIHNldCBhdCBjcmVhdGlvbi4AAAARRHVwbGljYXRlUmVsZWFzZXIAAAAAAAARAAAAAAAAABJBY2NlcHRhbmNlUmVxdWlyZWQAAAAAABIAAAAAAAAAF0FjY2VwdGFuY2VOb3RDb25maWd1cmVkAAAAABMAAAAAAAAAD0FscmVhZHlBY2NlcHRlZAAAAAAUAAAAfGByZWZ1bmRfdG9gIHdhcyB0aGUgZXNjcm93IGNvbnRyYWN0J3Mgb3duIGFkZHJlc3Mg4oCUIGZ1bmRzIHNlbnQKdGhlcmUgb24gcmVmdW5kIGNvdWxkIG5ldmVyIGJlIG1vdmVkIGFnYWluIChkb2NzL2Fkci8wMDA5KS4AAAAPSW52YWxpZFJlZnVuZFRvAAAAABUAAABEVGhlIGNvbmZpZ3VyZWQgcmVsZWFzZSB0aW1lIGlzIGluIHRoZSBwYXN0IG9yIGFmdGVyIHRoZSByZWZ1bmQgdGltZS4AAAAXSW52YWxpZFJlbGVhc2VOb3RCZWZvcmUAAAAAFgAAADFSZWxlYXNlIHdhcyBhdHRlbXB0ZWQgYmVmb3JlIHRoZSBjb25maWd1cmVkIHRpbWUuAAAAAAAAD1JlbGVhc2VUb29FYXJseQAAAAAX",
        "AAAAAQAAAAAAAAAAAAAACkVzY3Jvd0RhdGEAAAAAAA4AAAA1TGVkZ2VyIHRpbWVzdGFtcCBhdCB3aGljaCB0aGUgcGF5ZWUgYWNjZXB0ZWQsIGlmIGFueS4AAAAAAAALYWNjZXB0ZWRfYXQAAAAD6AAAAAYAAAAAAAAABmFtb3VudAAAAAAACwAAATpPcGFxdWUgY2FsbGVyLXN1cHBsaWVkIHJlZmVyZW5jZSB0aGUgY29udHJhY3Qgc3RvcmVzIGJ1dCBuZXZlcgppbnRlcnByZXRzIChkb2NzL2Fkci8wMDAxKS4gVGhpcyBmaWVsZCBpcyAqKnB1YmxpYyBvbi1jaGFpbiBmb3JldmVyKiosCmxpa2UgdGhlIHJlc3Qgb2YgYEVzY3Jvd0RhdGFgIChkb2NzL3RocmVhdC1tb2RlbC5tZCBUOSk6IG5ldmVyIHB1dApwcml2YXRlLCBwZXJzb25hbCBvciBzZW5zaXRpdmUgZGF0YSBoZXJlLiBQYXNzIGFuIG9wYXF1ZSwgbWVhbmluZ2xlc3MKaWQgc3VjaCBhcyBhIFVVSUQgb3IgYW4gaW50ZXJuYWwgcmVjb3JkIGlkLgAAAAAADWNvbmRpdGlvbl9yZWYAAAAAAAAQAAAAhklmIHRydWUsIGludm9rZSB0aGUgY29udHJhY3QgcGF5ZWUncyBgb25fZXNjcm93X3JlbGVhc2VkYCBob29rIGFmdGVyCnRoZSBwYXlvdXQgdHJhbnNmZXIuIEEgZmFpbGVkIGNhbGxiYWNrIHJldmVydHMgdGhlIHdob2xlIHJlbGVhc2UuAAAAAAAMbm90aWZ5X3BheWVlAAAAAQAAAAAAAAAFcGF5ZWUAAAAAAAATAAAAelRoZSBmdW5kZXI6IGF1dGhvcmlzZXMgYW5kIHBheXMgZm9yIHRoZSBlc2Nyb3cgYXQgY3JlYXRpb24uIEFsc28KdGhlIHJlZnVuZCBkZXN0aW5hdGlvbiB1bmxlc3MgYHJlZnVuZF90b2Agc2F5cyBvdGhlcndpc2UuAAAAAAAFcGF5ZXIAAAAAAAATAAAAxU9wdGlvbmFsIGRlYWRsaW5lICh1bml4IHNlY29uZHMpIGFmdGVyIHdoaWNoIGByZWZ1bmRgIG9wZW5zIHRvCmFueW9uZSDigJQgc3RpbGwgb25seSB0byBgcmVmdW5kX3RvYC4gYE5vbmVgIG1lYW5zIG5vIHRpbWVvdXQsCmJlaGF2aW91ciBpZGVudGljYWwgdG8gYmVmb3JlIHRoaXMgZmllbGQgZXhpc3RlZCDigJQgc2VlIGRvY3MvYWRyLzAwMDQuAAAAAAAADHJlZnVuZF9hZnRlcgAAA+gAAAAGAAAA4VdoZXJlICoqZXZlcnkqKiByZWZ1bmQgcGF0aCAocmVsZWFzZXIsIHRpbWVvdXQpIHNlbmRzIHRoZSBmdW5kcy4KRml4ZWQgYXQgY3JlYXRpb24gdW5kZXIgdGhlIGZ1bmRlcidzIGF1dGggYW5kIG5ldmVyIGNob3NlbiBhdApwYXlvdXQsIHNvIGludmFyaWFudCBJMSBob2xkczsgZGVmYXVsdHMgdG8gYHBheWVyYCB3aGVuIG9taXR0ZWQgYXQKY3JlYXRpb24g4oCUIHNlZSBkb2NzL2Fkci8wMDA5LgAAAAAAAAlyZWZ1bmRfdG8AAAAAAAATAAAANkVhcmxpZXN0IGxlZGdlciB0aW1lc3RhbXAgYXQgd2hpY2ggcmVsZWFzZSBpcyBhbGxvd2VkLgAAAAAAEnJlbGVhc2Vfbm90X2JlZm9yZQAAAAAD6AAAAAYAAAC9QWRkcmVzc2VzIHBlcm1pdHRlZCB0byBzZXR0bGUgdGhpcyBlc2Nyb3cg4oCUIHNlZSBkb2NzL2Fkci8wMDAyIGZvciB0aGUKcGVyLWVzY3JvdyByZWxlYXNlciwgYW5kIGRvY3MvYWRyLzAwMDcgZm9yIE0tb2YtTiBzZXRzLiBBIHBsYWluCnNpbmdsZS1yZWxlYXNlciBlc2Nyb3cgc3RvcmVzIGV4YWN0bHkgb25lIGVudHJ5IGhlcmUuAAAAAAAACXJlbGVhc2VycwAAAAAAA+oAAAATAAAAOVdoZXRoZXIgcmVsZWFzZSByZXF1aXJlcyB0aGUgcGF5ZWUncyBleHBsaWNpdCBhY2NlcHRhbmNlLgAAAAAAABNyZXF1aXJlc19hY2NlcHRhbmNlAAAAAAEAAAAAAAAABnN0YXR1cwAAAAAH0AAAAAxFc2Nyb3dTdGF0dXMAAAC6SG93IG1hbnkgKmRpc3RpbmN0KiBhZGRyZXNzZXMgZnJvbSBgcmVsZWFzZXJzYCBtdXN0IGF1dGhvcml6ZSBvbmUKc2V0dGxlbWVudC4gQWx3YXlzIGA+PSAxYCBhbmQgYDw9IHJlbGVhc2Vycy5sZW4oKWA7IGAxYCBtZWFucyBhbnkKc2luZ2xlIHJlbGVhc2VyIGNhbiBzZXR0bGUgKHRoZSBwcmUtcXVvcnVtIGJlaGF2aW91cikuAAAAAAAJdGhyZXNob2xkAAAAAAAABAAAAAAAAAAFdG9rZW4AAAAAAAAT",
        "AAAAAgAAAAAAAAAAAAAADEVzY3Jvd1N0YXR1cwAAAAMAAAAAAAAAAAAAAAZGdW5kZWQAAAAAAAAAAAAAAAAACFJlbGVhc2VkAAAAAAAAAAAAAAAIUmVmdW5kZWQ=",
        "AAAAAAAAAD1SZWNvcmRzIHRoZSBwYXllZSdzIGFjY2VwdGFuY2UgZm9yIGFuIG9wdGVkLWluIGZ1bmRlZCBlc2Nyb3cuAAAAAAAABmFjY2VwdAAAAAAAAgAAAAAAAAAJZXNjcm93X2lkAAAAAAAABgAAAAAAAAAFcGF5ZWUAAAAAAAATAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAA5dMZXRzIHRoZSBwYXllciB0YWtlIHRoZSBmdW5kcyBiYWNrICoqYmVmb3JlIHRoZSBwYXllZSBhY2NlcHRzKioKKGRvY3MvYWRyLzAwMTApOiByZXR1cm5zIHRoZSBlc2Nyb3dlZCBgYW1vdW50YCB0byBgcmVmdW5kX3RvYCAodGhlCmBwYXllcmAgdW5sZXNzIGEgc3BvbnNvciBkZXN0aW5hdGlvbiB3YXMgZml4ZWQgYXQgY3JlYXRpb24sIEFEUgowMDA5KSBhbmQgbWFya3MgdGhlIGVzY3JvdyBgQ2FuY2VsbGVkYC4gQWxsb3dlZCBvbmx5IHdoaWxlICoqYWxsKioKaG9sZDoKCi0gYHBheWVyYCBpcyB0aGUgZXNjcm93J3Mgc3RvcmVkIHBheWVyIGFuZCBhdXRob3JpemVzIHRoZSBjYWxsOwotIHRoZSBlc2Nyb3cgaXMgc3RpbGwgYEZ1bmRlZGAgKGBOb3RGdW5kZWRgIG90aGVyd2lzZSDigJQgbmV2ZXIgYWZ0ZXIKYSByZWxlYXNlLCByZWZ1bmQgb3IgZWFybGllciBjYW5jZWwpOwotIGl0IHdhcyBjcmVhdGVkIHdpdGggYHJlcXVpcmVzX2FjY2VwdGFuY2VgCihgQWNjZXB0YW5jZU5vdENvbmZpZ3VyZWRgIG90aGVyd2lzZSDigJQgd2l0aG91dCB0aGUgZ2F0ZSB0aGVyZSBpcwpubyBhY2NlcHRhbmNlIHN0ZXAgdG8gcmFjZSwgc28gbm8gY2FuY2VsIHdpbmRvdyBleGlzdHMpOwotIHRoZSBwYXllZSBoYXMgbm90IGFjY2VwdGVkIChgQWxyZWFkeUFjY2VwdGVkYCBvdGhlcndpc2UpLgoKVGhlIGRlc3RpbmF0aW9uIGlzIHJlYWQgZnJvbSBzdG9yYWdlLCBzbyBpbnZhcmlhbnQgSTEgaXMgdW5jaGFuZ2VkLgpQYXllZXM6IGRvIG5vdCByZWx5IG9uIGEgYHJlcXVpcmVzX2FjY2VwdGFuY2VgIGVzY3JvdyB1bnRpbCB5b3UKaGF2ZSBjYWxsZWQgYGFjY2VwdGAuIGBhY2NlcHRgIGFuZCBgY2FuY2VsYCByYWNlIG9uIG9uZSBsZWRnZXIKc3RhdGU6IHdoaWNoZXZlciBsYW5kcyBmaXJzdCB3aW5zIGFuZCB0aGUgb3RoZXIgZmFpbHMuAAAAAAZjYW5jZWwAAAAAAAIAAAAAAAAACWVzY3Jvd19pZAAAAAAAAAYAAAAAAAAABXBheWVyAAAAAAAAEwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAA6ZSZXR1cm5zIHRoZSBlc2Nyb3dlZCBgYW1vdW50YCB0byB0aGUgZXNjcm93J3MgYHJlZnVuZF90b2AgKHRoZQpgcGF5ZXJgIHVubGVzcyBhIGRpZmZlcmVudCBkZXN0aW5hdGlvbiB3YXMgZml4ZWQgYXQgY3JlYXRpb24g4oCUCmRvY3MvYWRyLzAwMDYpLiBTYW1lIHN0YXRlIHJ1bGUgYXMKYHJlbGVhc2VgIChvbmx5IHdoaWxlIGBGdW5kZWRgKSwgYnV0IHR3byBjYWxsZXJzIGFyZSBhdXRob3Jpc2VkOgoKLSB0aGUgZXNjcm93J3MgcmVsZWFzZXIgKGRvY3MvYWRyLzAwMDIpLCBhbHdheXM7IG9yCi0gKiphbnlvbmUqKiwgb25jZSBgcmVmdW5kX2FmdGVyYCBoYXMgYmVlbiByZWFjaGVkIOKAlCB0aGUgdGltZW91dApyZWZ1bmQgcGF0aCBmb3IgYSBsb3N0L3Vuc2lnbmFibGUgcmVsZWFzZXIga2V5IChkb2NzL2Fkci8wMDA0KS4KClRoZSBkZXN0aW5hdGlvbiBuZXZlciBjaGFuZ2VzOiB0aW1lb3V0IG9yIG5vdCwgZnVuZHMgb25seSBldmVyIGdvCnRvIHRoZSBzdG9yZWQgYHJlZnVuZF90b2AsIHdoaWNoIG5vIGNhbGxlciBjYW4gaW5mbHVlbmNlLiBXaXRoIG5vCmByZWZ1bmRfYWZ0ZXJgIHNldCwgYmVoYXZpb3VyIGlzIGlkZW50aWNhbCB0byBiZWZvcmUgdGhlIHRpbWVvdXQKZXhpc3RlZCDigJQgcmVsZWFzZXIgb25seS4gT24gYW4gTS1vZi1OIGVzY3JvdyB0aGUgcmVsZWFzZXIgcGF0aCBuZWVkcwphIHRocmVzaG9sZCBvZiAxOyBvdGhlcndpc2UgdXNlIGByZWZ1bmRfd2l0aF9hcHByb3ZhbHNgICh0aGUgdGltZW91dApwYXRoIHN0YXlzIG9wZW4gdG8gYW55b25lKS4gVGhlIHN0b3JlZCBwYXllZSBtYXkgYWxzbyB2b2x1bnRhcmlseQpyZWZ1bmQgYSBmdW5kZWQgZXNjcm93OyB0aGF0IHBhdGggZW1pdHMgYHBheWVlX3JlZnVuZGVkYCAoQURSIDAwMTApLgpBIHByb3RvY29sIGZlZSBpcyBuZXZlciB0YWtlbiBvbiB0aGUgcmVmdW5kIHBhdGguAAAAAAAGcmVmdW5kAAAAAAACAAAAAAAAAAllc2Nyb3dfaWQAAAAAAAAGAAAAAAAAAAZjYWxsZXIAAAAAABMAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAHVBZGRzIGZ1bmRzIHRvIGEgZnVuZGVkIGVzY3JvdyB3aXRob3V0IGNoYW5naW5nIGl0cyBwYXJ0aWVzIG9yIGlkLgpPbmx5IGl0cyBvcmlnaW5hbCBwYXllciBtYXkgYXV0aG9yaXplIHRoZSB0cmFuc2Zlci4AAAAAAAAGdG9wX3VwAAAAAAADAAAAAAAAAAllc2Nyb3dfaWQAAAAAAAAGAAAAAAAAAAVwYXllcgAAAAAAABMAAAAAAAAABmFtb3VudAAAAAAACwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAABQAAAEJJZGVudGlmaWVzIHZvbHVudGFyeSByZWZ1bmRzIHN0YXJ0ZWQgYnkgdGhlIGVzY3JvdydzIHN0b3JlZCBwYXllZS4AAAAAAAAAAAANUGF5ZWVSZWZ1bmRlZAAAAAAAAAEAAAAOcGF5ZWVfcmVmdW5kZWQAAAAAAAQAAAAAAAAACWVzY3Jvd19pZAAAAAAAAAYAAAABAAAAAAAAAAVwYXllcgAAAAAAABMAAAABAAAAAAAAAAVwYXllZQAAAAAAABMAAAABAAAAAAAAAAZhbW91bnQAAAAAAAsAAAAAAAAAAg==",
        "AAAAAAAAAtpNb3ZlcyB0aGUgZXNjcm93ZWQgYGFtb3VudGAgdG8gYHBheWVlYC4gT25seSB0aGUgZXNjcm93J3MgcmVsZWFzZXIKbWF5IGNhbGwgdGhpcyDigJQgdGhlIGNvbnRyYWN0IGVuZm9yY2VzIFdITywgbmV2ZXIgV0hZIChBRFIgMDAwMSkuIE9uCmFuIE0tb2YtTiBlc2Nyb3cgdGhpcyBzaW5nbGUtY2FsbGVyIHBhdGggaXMgb25seSBhbGxvd2VkIHdoZW4gdGhlCnRocmVzaG9sZCBpcyAxOyBvdGhlcndpc2UgdXNlIGByZWxlYXNlX3dpdGhfYXBwcm92YWxzYC4KCkRlbGliZXJhdGVseSAqKm5vdCoqIGdhdGVkIGJ5IGByZWZ1bmRfYWZ0ZXJgIChkb2NzL2Fkci8wMDA0KTogYWZ0ZXIKdGhlIGRlYWRsaW5lIHRoZSByZWxlYXNlciBjYW4gc3RpbGwgcmVsZWFzZSwgcmFjaW5nIGFueSB0aW1lb3V0CnJlZnVuZCDigJQgd2hvZXZlciBsYW5kcyBmaXJzdCB3aW5zIGFuZCB0aGUgb3RoZXIgZmFpbHMgYE5vdEZ1bmRlZGAuCgpJZiB0aGUgZXNjcm93IHdhcyBjcmVhdGVkIHdpdGggYSBmZWUgKGRvY3MvYWRyLzAwMTApLCB0aGUgZmVlIGNvbWVzCm9mZiB0aGUgdG9wIOKAlCBg4oyKYW1vdW50IMOXIGZlZV9icHMgw7cgMTAgMDAw4oyLYCBnb2VzIHRvIGBmZWVfcmVjaXBpZW50YCwKdGhlIGV4YWN0IHJlbWFpbmRlciB0byBgcGF5ZWVgLCBzbyB0aGUgdHdvIHRyYW5zZmVycyBhbHdheXMgc3VtIHRvCnRoZSBlc2Nyb3dlZCBgYW1vdW50YC4gTm8gZmVlIGlzIGV2ZXIgdGFrZW4gb24gYHJlZnVuZGAuAAAAAAAHcmVsZWFzZQAAAAACAAAAAAAAAAllc2Nyb3dfaWQAAAAAAAAGAAAAAAAAAAZjYWxsZXIAAAAAABMAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAKdTZW1hbnRpYyB2ZXJzaW9uIG9mIHRoaXMgY29udHJhY3QgaW50ZXJmYWNlIGFuZCBiZWhhdmlvci4KQnVpbGQgcHJvdmVuYW5jZSBpcyBhdmFpbGFibGUgc2VwYXJhdGVseSBpbiB0aGUgV0FTTSBjb250cmFjdAptZXRhZGF0YSAoYGdpdF9zaGFgIGFuZCBgc29yb2Jhbl9zZGtfdmVyc2lvbmApLgAAAAAHdmVyc2lvbgAAAAAAAAAAAQAAABA=",
        "AAAAAAAAArVSZWFkLW9ubHkgc29sdmVuY3kgY2hlY2sgZm9yIG9uZSB0b2tlbiAoaXNzdWUgIzM5KTogcmV0dXJucwpgKGJhbGFuY2UsIGxpYWJpbGl0aWVzKWAsIHdoZXJlIGBiYWxhbmNlYCBpcyB0aGlzIGNvbnRyYWN0J3MgY3VycmVudApiYWxhbmNlIG9mIGB0b2tlbmAgYW5kIGBsaWFiaWxpdGllc2AgaXMgdGhlIHN1bSBvZiBgYW1vdW50YCBvdmVyCmV2ZXJ5IGVzY3JvdyBpbiBgdG9rZW5gIHRoYXQgaXMgc3RpbGwgYEZ1bmRlZGAgKHBvb2xlZCBlc2Nyb3dzIGNvdW50CnRoZWlyIGZ1bmRlZCB0b3RhbCBuZXQgb2YgY2xhaW1lZCByZWZ1bmRzKS4gVGhlIGNvbnRyYWN0IGlzIHNvbHZlbnQKZm9yIGB0b2tlbmAgZXhhY3RseSB3aGVuIGBiYWxhbmNlID49IGxpYWJpbGl0aWVzYC4KCmBsaWFiaWxpdGllc2AgaXMgbWFpbnRhaW5lZCBvbi1jaGFpbiBieSBldmVyeSBzdGF0ZSBjaGFuZ2UgdGhhdAptb3ZlcyB2YWx1ZSDigJQgY3JlYXRpb24sIGB0b3BfdXBgIGFuZCBgY29udHJpYnV0ZWAgYWRkLCBhbmQKcmVsZWFzZS9yZWZ1bmQvY2FuY2VsL2BjbGFpbV9yZWZ1bmRgIHN1YnRyYWN0IOKAlCBpbiB0aGUgc2FtZQppbnZvY2F0aW9uLCBzbyBpdCBjYW4gbmV2ZXIgZHJpZnQgZnJvbSB0aGUgZXNjcm93cyB0aGVtc2VsdmVzLgpBIHRva2VuIG5ldmVyIHVzZWQgYnkgdGhpcyBjb250cmFjdCByZXBvcnRzIGAwYCBsaWFiaWxpdGllcy4AAAAAAAAIc29sdmVuY3kAAAABAAAAAAAAAAV0b2tlbgAAAAAAABMAAAABAAAD7QAAAAIAAAALAAAACw==",
        "AAAAAAAAA65BZGRzIGBhbW91bnRgIHRvIGEgcG9vbGVkIGVzY3JvdyBmcm9tIGBwYXllcmAgKGlzc3VlICMxMTMsCmRvY3MvYWRyLzAwMTEpLiBQZXJtaXNzaW9ubGVzcyDigJQgYW55b25lIG1heSBmdW5kIOKAlCBidXQgZXZlcnkKY29udHJpYnV0aW9uOgotIG11c3QgYmUgYSBwb3NpdGl2ZSBhbW91bnQgKGBJbnZhbGlkQW1vdW50YCk7Ci0gaXMgYWNjZXB0ZWQgb25seSB3aGlsZSB0aGUgZXNjcm93IGlzIGBGdW5kZWRgIGFuZCB0aGUgbGVkZ2VyCnRpbWVzdGFtcCBpcyBzdHJpY3RseSBiZWZvcmUgdGhlIGZ1bmRpbmcgZGVhZGxpbmUKKGBGdW5kaW5nRGVhZGxpbmVQYXNzZWRgIGFmdGVyIGl0IOKAlCBsYXRlIG1vbmV5IGNhbiBuZXZlciBjaGFuZ2UgYQpyb3VuZCdzIG91dGNvbWUpOwotIG1heSBub3QgcHVzaCB0aGUgcG9vbGVkIHRvdGFsIHBhc3QgdGhlIGZ1bmRpbmcgdGFyZ2V0CihgRnVuZGluZ1RhcmdldFJlYWNoZWRgIOKAlCBvdmVyZnVuZGluZyBpcyByZWplY3RlZCwgbm90IHJlZnVuZGVkKTsKLSBpcyBwdWxsZWQgZnJvbSBgcGF5ZXJgIHVuZGVyIGBwYXllci5yZXF1aXJlX2F1dGgoKWAgYW5kIHZlcmlmaWVkCndpdGggdGhlIHNhbWUgZXhhY3QgYmFsYW5jZS1kZWx0YSBjaGVjayBhcyBjcmVhdGlvbgooYEJhbGFuY2VNaXNtYXRjaGAgaWYgdGhlIGNvbnRyYWN0J3MgYmFsYW5jZSBkaWRuJ3QgcmlzZSBieQpleGFjdGx5IGBhbW91bnRgKTsKLSBpcyByZWNvcmRlZCBhZ2FpbnN0IGBwYXllcmAgb25seSwgYWNjdW11bGF0aW5nIGFjcm9zcyByZXBlYXRlZApjb250cmlidXRpb25zIGFuZCBuZXZlciB0b3VjaGluZyBvdGhlciBwYXllcnMnIHJlY29yZHMuCkFjY291bnRpbmcgaXMgdXBkYXRlZCBvbmx5IGFmdGVyIHRoZSB0cmFuc2ZlciBpcyB2ZXJpZmllZCwgc28gYQpmYWlsZWQgY29udHJpYnV0aW9uIHJlY29yZHMgbm90aGluZyAoaW52YXJpYW50IEk0KS4AAAAAAApjb250cmlidXRlAAAAAAADAAAAAAAAAAllc2Nyb3dfaWQAAAAAAAAGAAAAAAAAAAVwYXllcgAAAAAAABMAAAAAAAAABmFtb3VudAAAAAAACwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAd1SZWFkLW9ubHkgYWNjZXNzb3IgZm9yIGV2ZXJ5dGhpbmcgc3RvcmVkIGFib3V0IGBlc2Nyb3dfaWRgIOKAlCBwYXllciwKcGF5ZWUsIHRva2VuLCBhbW91bnQsIGBjb25kaXRpb25fcmVmYCwgc3RhdHVzLCB0aGUgcmVsZWFzZXIgc2V0IHdpdGgKaXRzIHRocmVzaG9sZCwgYHJlZnVuZF9hZnRlcmAsIGByZWZ1bmRfdG9gIGFuZCB0aGUgb3B0aW9uYWwgZmVlCihgZmVlX3JlY2lwaWVudGAvYGZlZV9icHNgLCBleGFjdGx5IGFzIGRlY2xhcmVkIGF0IGNyZWF0aW9uKS4gRXhpc3RzCnNvIHBheWVlcyBhbmQgaW50ZWdyYXRvcnMgY2FuIGNoZWNrIHdobyBjYW4gc2V0dGxlLCB3aGVuLCB3aGVyZSBhCnJlZnVuZCBnb2VzIGFuZCB0aGUgZXhhY3QgZmVlIGJlZm9yZSByZWx5aW5nIG9uIGEgYEZ1bmRlZGAgZXNjcm93Cihkb2NzL2Fkci8wMDA0LCB0aHJlYXQgbW9kZWwgVDg7IGRvY3MvYWRyLzAwMTApLiBFcnJvcnMgb24gYW4KdW5rbm93biBpZC4AAAAAAAAKZ2V0X2VzY3JvdwAAAAAAAQAAAAAAAAAJZXNjcm93X2lkAAAAAAAABgAAAAEAAAPpAAAH0AAAAApFc2Nyb3dEYXRhAAAAAAAD",
        "AAAAAAAAATdSZWFkLW9ubHk6IHRoZSBpbW11dGFibGUgZnVuZGluZyBjb25maWcgb2YgYSBwb29sZWQgZXNjcm93LiBUaGUKYWdncmVnYXRlIGZ1bmRlZCBhbW91bnQgaXMgdGhlIGVzY3JvdydzIGBhbW91bnRgIGZyb20gYGdldF9lc2Nyb3dgOwphIHJvdW5kIGlzIGZhaWxlZCB3aGVuIGBub3cgPj0gZnVuZGluZ19kZWFkbGluZWAgYW5kIGBhbW91bnQgPApmdW5kaW5nX3RhcmdldGAgKHRoZW4gYGNsYWltX3JlZnVuZGAgaXMgb3BlbiB0byBlYWNoIGNvbnRyaWJ1dG9yKS4KRXJyb3JzIGBOb3RQb29sZWRgIG9uIGEgbm9uLXBvb2xlZCBvciB1bmtub3duIGlkLgAAAAAKZ2V0X3Bvb2xlZAAAAAAAAQAAAAAAAAAJZXNjcm93X2lkAAAAAAAABgAAAAEAAAPpAAAH0AAAAApQb29sZWREYXRhAAAAAAAD",
        "AAAAAAAAADxSZWFkLW9ubHkgc3RhdHVzIHF1ZXJ5LiBFcnJvcnMgaWYgYGVzY3Jvd19pZGAgZG9lc24ndCBleGlzdC4AAAAKZ2V0X3N0YXR1cwAAAAAAAQAAAAAAAAAJZXNjcm93X2lkAAAAAAAABgAAAAEAAAPpAAAH0AAAAAxFc2Nyb3dTdGF0dXMAAAAD",
        "AAAAAAAABABTZXR0bGVzIG1hbnkgZXNjcm93cyBpbiBvbmUgdHJhbnNhY3Rpb24gKGlzc3VlICMyOSwgZG9jcy9hZHIvMDAxMikg4oCUCnRoZSBmYXN0IHBhdGggZm9yIHRocmVhdCBtb2RlbCBUMSdzICJyYWNlIHRoZSBhdHRhY2tlciIgcmVzcG9uc2UgYW5kCmZvciBoaWdoLXZvbHVtZSBpbnRlZ3JhdG9ycy4gRWFjaCBgKGVzY3Jvd19pZCwgYWN0aW9uKWAgaXMgY2hlY2tlZApleGFjdGx5IGxpa2UgdGhlIHNpbmdsZS1lc2Nyb3cgZW50cnkgcG9pbnQgaXQgbWlycm9yczoKCi0gYFJlbGVhc2VgOiBgY2FsbGVyYCBtdXN0IGJlIGEgcmVsZWFzZXIgb2YgdGhhdCBlc2Nyb3cgd2l0aAp0aHJlc2hvbGQgMSwgdGhlIGVzY3JvdyBtdXN0IGJlIGBGdW5kZWRgLCBhIHBvb2xlZCBlc2Nyb3cgbXVzdCBiZQpmdWxseSBmdW5kZWQsIGFuZCBgcmVsZWFzZV9ub3RfYmVmb3JlYC9wYXllZSBhY2NlcHRhbmNlIGFwcGx5LgotIGBSZWZ1bmRgOiBwb29sZWQgZXNjcm93cyBhcmUgcmVqZWN0ZWQ7IGBjYWxsZXJgIG11c3QgYmUgYSByZWxlYXNlcgoodGhyZXNob2xkIDEpIHVubGVzcyBgcmVmdW5kX2FmdGVyYCBoYXMgcGFzc2VkLCBpbiB3aGljaCBjYXNlCmFueW9uZSBtYXkgcmVmdW5kIOKAlCBhbHdheXMgdG8gdGhlIHN0b3JlZCBgcmVmdW5kX3RvYC4KCmBjYWxsZXJgIGF1dGhvcml6ZXMgdGhlIHdob2xlIGJhdGNoIG9uY2UuIFBlci1vcCBhdXRob3JpdHkgY29tZXMKb25seSBmcm9tIGVhY2ggZXNjcm93J3Mgb3duIHN0b3JlZCByZWxlYXNlciBzZXQsIHNvIGEgYmF0Y2ggY2FuIG5ldmVyCnNldHRsZSBhbiBlc2Nyb3cgd2hvc2UgcmVsZWFzZXIgaXMgc29tZW9uZSBlbHNlOiB0aGF0IG9wIHJldHVybnMKYFVuYXV0aG9yaXplZGAgYW5kIHRvdWNoZXMgbm90aGluZy4KCioqQmVzdC1lZmZvcnQgd2l0aCBwZXItb3AgcmVzdWx0czoqKiB0aGUgcmV0dXJuZWQgdmVjdG9yIGhhcyBvbmUKZW50cnkgcGVyIGlucHV0IG9wLCBpbiBpbnB1dCBvcmRlci4gYE9rKCgpKWAgbWVhbnMgdGhhdCBlc2Nyb3cgd2FzCnNldHRsZWQgYnkgdGhpAAAAC3NldHRsZV9tYW55AAAAAAIAAAAAAAAABmNhbGxlcgAAAAAAEwAAAAAAAAADb3BzAAAAA+oAAAPtAAAAAgAAAAYAAAfQAAAADFNldHRsZUFjdGlvbgAAAAEAAAPpAAAD6gAAA+kAAAACAAAAAwAAAAM=",
        "AAAAAAAAA0JQdWxsLWJhc2VkIHJlZnVuZCAoaXNzdWUgIzExMywgZG9jcy9hZHIvMDAxMSk6IHBheXMgYGNvbnRyaWJ1dG9yYApleGFjdGx5IHRoZSBhbW91bnQgcmVjb3JkZWQgYWdhaW5zdCB0aGF0IGFkZHJlc3MsIG9uY2UuIEF2YWlsYWJsZQpvbmx5IGZvciBhICpmYWlsZWQqIGZ1bmRpbmcgcm91bmQg4oCUIHRoZSBmdW5kaW5nIGRlYWRsaW5lIGhhcyBwYXNzZWQKd2l0aCB0aGUgcG9vbGVkIHRvdGFsIHN0aWxsIGJlbG93IHRoZSB0YXJnZXQgKGBSZWZ1bmROb3RPcGVuYApvdGhlcndpc2UpIOKAlCBhbmQgb25seSB3aGlsZSB0aGUgZXNjcm93IGhhcyBub3QgYmVlbiByZWxlYXNlZAooYE5vdEZ1bmRlZGAgYWZ0ZXJ3YXJkczogcmVsZWFzZWQgZnVuZHMgY2FuIG5ldmVyIGJlIGNsYWltZWQpLgpFYWNoIGNsYWltIGlzIE8oMSkgd29yayDigJQgbm8gcGF0aCBpdGVyYXRlcyBjb250cmlidXRvcnMg4oCUIGFuZCBpdHMKb3duIGF1dGhvcml6YXRpb246IG5vIG9uZSBjYW4gY2xhaW0gb24gYW5vdGhlciBjb250cmlidXRvcidzCmJlaGFsZiAoYE5vQ29udHJpYnV0aW9uYCBmb3IgYW4gYWRkcmVzcyB3aXRoIG5vIHJlY29yZCksIGEgc2Vjb25kCmNsYWltIGZhaWxzIGBBbHJlYWR5UmVmdW5kZWRgLCBhbmQgdGhlIG9yZGVyIG9mIGNsYWltcyBjYW4gbmV2ZXIKY2hhbmdlIGFueW9uZSdzIGVudGl0bGVtZW50LiBDaGVja3MtZWZmZWN0cy1pbnRlcmFjdGlvbnM6IHRoZQpgcmVmdW5kZWRgIGZsYWcgYW5kIHRoZSBwb29sZWQgdG90YWwgYXJlIHdyaXR0ZW4gYmVmb3JlIHRoZQp0cmFuc2ZlciwgYW5kIGEgZmFpbGluZyB0cmFuc2ZlciByb2xscyB0aGUgd2hvbGUgY2xhaW0gYmFjay4AAAAAAAxjbGFpbV9yZWZ1bmQAAAACAAAAAAAAAAllc2Nyb3dfaWQAAAAAAAAGAAAAAAAAAAtjb250cmlidXRvcgAAAAATAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAHtTZXRzIHRoZSBpbW11dGFibGUgdG9rZW4gYWxsb3dsaXN0IGF0IGRlcGxveW1lbnQuIEFuIGVtcHR5IGxpc3QKcHJlc2VydmVzIHRoZSBsZWdhY3kgYmVoYXZpb3IgYW5kIGFsbG93cyBhbnkgdG9rZW4gYWRkcmVzcy4AAAAADV9fY29uc3RydWN0b3IAAAAAAAABAAAAAAAAAA5hbGxvd2VkX3Rva2VucwAAAAAD6gAAABMAAAAA",
        "AAAAAAAAA59Mb2NrcyBgYW1vdW50YCBvZiBgdG9rZW5gIHB1bGxlZCBmcm9tIGBwYXllcmAsIGhlbGQgZm9yIGBwYXllZWAsCmRvY3MvdGhyZWF0LW1vZGVsLm1kIFQxMCBhbmQgUk9BRE1BUC5tZCBQaGFzZSBFNSkuIGByZWxlYXNlcmAgaXMgdGhlCmFkZHJlc3MgcGVybWl0dGVkIHRvIGNhbGwgYHJlbGVhc2VgL2ByZWZ1bmRgIG9uIHRoaXMgZXNjcm93Cihkb2NzL2Fkci8wMDAyKS4gYHJlZnVuZF9hZnRlcmAgaXMgb3B0aW9uYWwgKGRvY3MvYWRyLzAwMDQpLgpgbm90aWZ5X3BheWVlYCBvcHRzIGFuIGltcGxlbWVudGluZyBjb250cmFjdCBwYXllZSBpbnRvCmBvbl9lc2Nyb3dfcmVsZWFzZWQoZXNjcm93X2lkLCBhbW91bnQpYCAoZG9jcy9hZHIvMDAwNSkuIFRoZSBwYXllcgptdXN0IGF1dGhvcml6ZSBjcmVhdGlvbiwgYW5kIHRoZSBwYXllZSBtdXN0IGFsc28gYXV0aG9yaXplIGlmCmBub3RpZnlfcGF5ZWVgIGlzIHRydWUuIGByZWZ1bmRfdG9gIGlzIHRoZSBvcHRpb25hbCByZWZ1bmQKZGVzdGluYXRpb24gZm9yIGEgc3BvbnNvcmVkIGVzY3JvdyB3aGVyZSB0aGUgZnVuZGVyIChgcGF5ZXJgKSBpcwpub3Qgd2hvIHNob3VsZCBnZXQgdGhlIG1vbmV5IGJhY2sgKGRvY3MvYWRyLzAwMDkpOiBgTm9uZWAgbWVhbnMKYHBheWVyYDsgaXQgbWF5IG5vdCBiZSB0aGlzIGNvbnRyYWN0J3Mgb3duIGFkZHJlc3MsIGFuZCB0aGUKYHBheWVyYCdzIGF1dGggb24gdGhpcyBjYWxsIGNvdmVycyBpdC4gYGNvbmRpdGlvbl9yZWZgIGlzIHN0b3JlZAp2ZXJiYXRpbSBhbmQgaXMgcHVibGljIG9uLWNoYWluIGZvcmV2ZXIgKGRvY3MvdGhyZWF0LW1vZGVsLm1kIFQ5KToKcGFzcyBhbiBvcGFxdWUgaWQsIG5ldmVyIHByaXZhdGUgb3IgcGVyc29uYWwgZGF0YS4gRm9yIE0tb2YtTgpyZWxlYXNlcnMgdXNlIGBjcmVhdGVfZXNjcm93X3dpdGhfcmVsZWFzZXJzYC4AAAAADWNyZWF0ZV9lc2Nyb3cAAAAAAAAJAAAAAAAAAAVwYXllcgAAAAAAABMAAAAAAAAABXBheWVlAAAAAAAAEwAAAAAAAAAFdG9rZW4AAAAAAAATAAAAAAAAAAZhbW91bnQAAAAAAAsAAAAAAAAADWNvbmRpdGlvbl9yZWYAAAAAAAAQAAAAAAAAAAhyZWxlYXNlcgAAABMAAAAAAAAADHJlZnVuZF9hZnRlcgAAA+gAAAAGAAAAAAAAAAxub3RpZnlfcGF5ZWUAAAABAAAAAAAAAAlyZWZ1bmRfdG8AAAAAAAPoAAAAEwAAAAEAAAPpAAAABgAAAAM=",
        "AAAAAAAAASdSZXR1cm5zIHRoZSBlc2Nyb3dlZCBgYW1vdW50YCB0byBgcmVmdW5kX3RvYCBvbiBiZWhhbGYgb2YgYW4gTS1vZi1OCnJlbGVhc2VyIHNldCAoZG9jcy9hZHIvMDAwNykuIFNhbWUgYXBwcm92YWwgcnVsZXMgYXMKYHJlbGVhc2Vfd2l0aF9hcHByb3ZhbHNgLiBUaGUgdGltZW91dCByZWZ1bmQgcGF0aCBpbiBgcmVmdW5kYCBzdGF5cwphdmFpbGFibGUgYXMgd2VsbDogb25jZSBgcmVmdW5kX2FmdGVyYCBwYXNzZXMsIGFueW9uZSBjYW4gcmV0dXJuIHRoZQpmdW5kcyB0byB0aGUgcGF5ZXIgd2l0aG91dCBhcHByb3ZhbHMuAAAAABVyZWZ1bmRfd2l0aF9hcHByb3ZhbHMAAAAAAAACAAAAAAAAAAllc2Nyb3dfaWQAAAAAAAAGAAAAAAAAAAlhcHByb3ZlcnMAAAAAAAPqAAAAEwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAZFNb3ZlcyB0aGUgZXNjcm93ZWQgYGFtb3VudGAgdG8gYHBheWVlYCBvbiBiZWhhbGYgb2YgYW4gTS1vZi1OCnJlbGVhc2VyIHNldCAoZG9jcy9hZHIvMDAwNykuIEV2ZXJ5IGFkZHJlc3MgaW4gYGFwcHJvdmVyc2AgbXVzdCBiZSBhCnJlbGVhc2VyLCBhcHBlYXIgYXQgbW9zdCBvbmNlLCBhbmQgYXV0aG9yaXplIHRoaXMgZXhhY3QgaW52b2NhdGlvbjsKYXQgbGVhc3QgYHRocmVzaG9sZGAgZGlzdGluY3QgYXBwcm92ZXJzIGFyZSByZXF1aXJlZC4gQXBwcm92YWxzIGFyZQpub3Qgc3RvcmVkIGJldHdlZW4gY2FsbHMsIHNvIHRoZXJlIGlzIG5vdGhpbmcgdG8gY2xlYXIgb24gc2V0dGxlbWVudAphbmQgbm8gYXBwcm92YWwgdG8gcmVwbGF5IOKAlCBhIHNldHRsZWQgZXNjcm93IGZhaWxzIGBOb3RGdW5kZWRgLgAAAAAAABZyZWxlYXNlX3dpdGhfYXBwcm92YWxzAAAAAAACAAAAAAAAAAllc2Nyb3dfaWQAAAAAAAAGAAAAAAAAAAlhcHByb3ZlcnMAAAAAAAPqAAAAEwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAANVDcmVhdGVzIGEgc2luZ2xlLXJlbGVhc2VyIGVzY3JvdyB3aXRoIGFuIG9wdGlvbmFsIGVhcmxpZXN0IHJlbGVhc2UgdGltZS4KUmVsZWFzZSBpcyBhbGxvd2VkIGF0IHRoZSBjb25maWd1cmVkIHRpbWVzdGFtcC4gQWNjZXB0cyB0aGUgc2FtZQpvcHRpb25hbCBgZmVlX3JlY2lwaWVudGAvYGZlZV9icHNgIHBhaXIgYXMgYGNyZWF0ZV9lc2Nyb3dgCihkb2NzL2Fkci8wMDEwKS4AAAAAAAAaY3JlYXRlX2VzY3Jvd19yZWxlYXNlX3RpbWUAAAAAAAwAAAAAAAAABXBheWVyAAAAAAAAEwAAAAAAAAAFcGF5ZWUAAAAAAAATAAAAAAAAAAV0b2tlbgAAAAAAABMAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAANY29uZGl0aW9uX3JlZgAAAAAAABAAAAAAAAAACHJlbGVhc2VyAAAAEwAAAAAAAAAMcmVmdW5kX2FmdGVyAAAD6AAAAAYAAAAAAAAADG5vdGlmeV9wYXllZQAAAAEAAAAAAAAACXJlZnVuZF90bwAAAAAAA+gAAAATAAAAAAAAABJyZWxlYXNlX25vdF9iZWZvcmUAAAAAA+gAAAAGAAAAAAAAAA1mZWVfcmVjaXBpZW50AAAAAAAD6AAAABMAAAAAAAAAB2ZlZV9icHMAAAAD6AAAAAQAAAABAAAD6QAAAAYAAAAD",
        "AAAAAAAAAZNTYW1lIGFzIGBjcmVhdGVfZXNjcm93YCwgYnV0IHRoZSBlc2Nyb3cgaXMgc2V0dGxlZCBieSBNLW9mLU4KcmVsZWFzZXJzIGluc3RlYWQgb2Ygb25lIGFkZHJlc3MgKGRvY3MvYWRyLzAwMDcpOiBgdGhyZXNob2xkYApkaXN0aW5jdCBhZGRyZXNzZXMgZnJvbSBgcmVsZWFzZXJzYCBtdXN0IGF1dGhvcml6ZSBhIHNldHRsZW1lbnQuClRoZSBzZXQgaXMgc3RvcmVkIGF0IGNyZWF0aW9uIGFuZCBjYW5ub3QgYmUgY2hhbmdlZCBhZnRlcndhcmRzIOKAlAp0aGVyZSBpcyBubyBhZG1pbiBhbmQgbm8gc2V0dGVyLiBSZWplY3RzIGFuIGVtcHR5IHNldCwgbW9yZSB0aGFuCjEwIHJlbGVhc2VycywgZHVwbGljYXRlIGFkZHJlc3NlcywgYW5kIGEgdGhyZXNob2xkIG9mIDAgb3Igb25lCmxhcmdlciB0aGFuIHRoZSBzZXQuAAAAABxjcmVhdGVfZXNjcm93X3dpdGhfcmVsZWFzZXJzAAAACgAAAAAAAAAFcGF5ZXIAAAAAAAATAAAAAAAAAAVwYXllZQAAAAAAABMAAAAAAAAABXRva2VuAAAAAAAAEwAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAA1jb25kaXRpb25fcmVmAAAAAAAAEAAAAAAAAAAJcmVsZWFzZXJzAAAAAAAD6gAAABMAAAAAAAAACXRocmVzaG9sZAAAAAAAAAQAAAAAAAAADHJlZnVuZF9hZnRlcgAAA+gAAAAGAAAAAAAAAAxub3RpZnlfcGF5ZWUAAAABAAAAAAAAAAlyZWZ1bmRfdG8AAAAAAAPoAAAAEwAAAAEAAAPpAAAABgAAAAM=",
        "AAAAAAAAAIZDcmVhdGVzIGFuIGVzY3JvdyB3aXRoIGFuIG9wdC1pbiBwYXllZSBhY2NlcHRhbmNlIGdhdGUuIEV4aXN0aW5nCmludGVncmF0aW9ucyBjYW4ga2VlcCB1c2luZyBgY3JlYXRlX2VzY3Jvd2AsIHdoaWNoIGRlZmF1bHRzIHRoaXMgb2ZmLgAAAAAAHWNyZWF0ZV9lc2Nyb3dfd2l0aF9hY2NlcHRhbmNlAAAAAAAACQAAAAAAAAAFcGF5ZXIAAAAAAAATAAAAAAAAAAVwYXllZQAAAAAAABMAAAAAAAAABXRva2VuAAAAAAAAEwAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAA1jb25kaXRpb25fcmVmAAAAAAAAEAAAAAAAAAAIcmVsZWFzZXIAAAATAAAAAAAAAAxyZWZ1bmRfYWZ0ZXIAAAPoAAAABgAAAAAAAAATcmVxdWlyZXNfYWNjZXB0YW5jZQAAAAABAAAAAAAAAAlyZWZ1bmRfdG8AAAAAAAPoAAAAEwAAAAEAAAPpAAAABgAAAAM=" ]),
      options
    )
  }
  public readonly fromJSON = {
    accept: this.txFromJSON<Result<void>>,
        cancel: this.txFromJSON<Result<void>>,
        refund: this.txFromJSON<Result<void>>,
        top_up: this.txFromJSON<Result<void>>,
        release: this.txFromJSON<Result<void>>,
        version: this.txFromJSON<string>,
        solvency: this.txFromJSON<readonly [i128, i128]>,
        contribute: this.txFromJSON<Result<void>>,
        get_escrow: this.txFromJSON<Result<EscrowData>>,
        get_pooled: this.txFromJSON<Result<PooledData>>,
        get_status: this.txFromJSON<Result<EscrowStatus>>,
        settle_many: this.txFromJSON<Result<Array<Result<void>>>>,
        claim_refund: this.txFromJSON<Result<void>>,
        create_escrow: this.txFromJSON<Result<u64>>,
        create_escrows: this.txFromJSON<Result<Array<u64>>>,
        transfer_payee: this.txFromJSON<Result<void>>,
        rotate_releaser: this.txFromJSON<Result<void>>,
        get_contribution: this.txFromJSON<Result<Option<Contribution>>>,
        create_pooled_escrow: this.txFromJSON<Result<u64>>,
        refund_with_approvals: this.txFromJSON<Result<void>>,
        release_with_approvals: this.txFromJSON<Result<void>>,
        create_escrow_release_time: this.txFromJSON<Result<u64>>,
        create_escrow_with_releasers: this.txFromJSON<Result<u64>>,
        create_escrow_with_acceptance: this.txFromJSON<Result<u64>>
  }
}