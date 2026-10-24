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
  34: {message:"InvalidFundingDeadline"}
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
  condition_ref: string;
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
 * The only state kept for a settled escrow (docs/adr/0012). Its parties,
 * token, amount and releasers live in the settlement event
 * (`publish_state`), not in persistent storage.
 */
export interface SettledEscrow {
  status: EscrowStatus;
}

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
   * path stays open to anyone).
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
   */
  release: ({escrow_id, caller}: {escrow_id: u64, caller: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

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
   * its threshold, `refund_after` and `refund_to`. Exists so payees and
   * integrators can check who can settle, when, and where a refund goes
   * before relying on a `Funded` escrow (docs/adr/0004, threat model T8).
   * Only `Funded` escrows have a full record: once settled it is reclaimed
   * (docs/adr/0012) and this returns `NotFound` — use `get_status` for a
   * settled id and the settlement event for its history.
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
   * Read-only status query. Answers for settled escrows too, from the
   * tombstone left on settlement (docs/adr/0012), so `NotFound` means
   * exactly one thing: this id was never created.
   */
  get_status: ({escrow_id}: {escrow_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<EscrowStatus>>>

  /**
   * Construct and simulate a settle_many transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Batch version of `release`: releases each escrow in `escrow_ids` in
   * order on behalf of `caller`, which must be a releaser of every one
   * of them. Returns a per-op result vector aligned with `escrow_ids`:
   * `Ok(())` for a successful release, `Err(e)` for one the contract
   * rejected (unknown id, not funded, caller not a releaser, before
   * `release_not_before`). A rejected op does not stop the rest — the
   * caller can inspect the vector and retry only the failures.
   * 
   * `escrow_ids.len()` must be `<= MAX_BATCH_SIZE` — see docs/adr/0005.
   */
  settle_many: ({caller, escrow_ids}: {caller: string, escrow_ids: Array<u64>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Array<Result<void>>>>>

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
   * `payer`'s auth on this call covers it. For M-of-N releasers use
   * `create_escrow_with_releasers`.
   */
  create_escrow: ({payer, payee, token, amount, condition_ref, releaser, refund_after, notify_payee, refund_to}: {payer: string, payee: string, token: string, amount: i128, condition_ref: string, releaser: string, refund_after: Option<u64>, notify_payee: boolean, refund_to: Option<string>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a create_escrows transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Batch version of `create_escrow`. Creates one escrow per item, in
   * input order, and returns the new ids in the same order as `items`.
   * `payer` authorizes once for the whole call. Fails atomically: if
   * any item is invalid (bad amount, past `refund_after`, oversized
   * `condition_ref`, short-delivering token) the whole call reverts and
   * no escrows are created.
   * 
   * `items.len()` must be `<= MAX_BATCH_SIZE` — see docs/adr/0005.
   */
  create_escrows: ({payer, items}: {payer: string, items: Array<CreateItem>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Array<u64>>>>

  /**
   * Construct and simulate a rotate_releaser transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Rotates a funded escrow's releaser. Both the current releaser and
   * payer must authorize the change; the payer's consent prevents a
   * compromised releaser from silently appointing an attacker. The
   * replacement cannot be the contract itself or the payee.
   */
  rotate_releaser: ({escrow_id, caller, new_releaser}: {escrow_id: u64, caller: string, new_releaser: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a get_contribution transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Read-only: one contributor's record on a pooled escrow — the exact
   * amount they can claim back from a failed round, and whether it has
   * already been claimed. `None` means the address never contributed.
   * Errors `NotFound` on an unknown id and `NotPooled` on a
   * non-pooled escrow.
   */
  get_contribution: ({escrow_id, contributor}: {escrow_id: u64, contributor: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Option<Contribution>>>>

  /**
   * Construct and simulate a create_pooled_escrow transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Creates a pooled escrow funded by many payers (issue #113,
   * docs/adr/0011). `creator` sets the deal — payee, token, releaser,
   * opaque `condition_ref`, an explicit `funding_target` (> 0) and a
   * `funding_deadline` (unix seconds, strictly in the future) — but
   * funds nothing at creation: `EscrowData.amount` starts at 0 and grows
   * as contributors call `contribute`. Release becomes possible only
   * once contributions reach the target exactly; if the deadline passes
   * first, the round has failed and every contributor pulls their own
   * recorded amount back with `claim_refund`. `creator` is stored as
   * the escrow's `payer` (co-authorization for `rotate_releaser` only)
   * and as the `refund_to` placeholder; no push refund path exists for
   * pooled escrows. No `refund_after`, no acceptance gate, no callback:
   * pooled settlement reuses the plain releaser/threshold rules.
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
   * Release is allowed at the configured timestamp.
   */
  create_escrow_release_time: ({payer, payee, token, amount, condition_ref, releaser, refund_after, notify_payee, refund_to, release_not_before}: {payer: string, payee: string, token: string, amount: i128, condition_ref: string, releaser: string, refund_after: Option<u64>, notify_payee: boolean, refund_to: Option<string>, release_not_before: Option<u64>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

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
      new ContractSpec([ "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAAIAAAAAAAAAAITm90Rm91bmQAAAABAAAAAAAAAA1JbnZhbGlkQW1vdW50AAAAAAAAAgAAAAAAAAAMVW5hdXRob3JpemVkAAAAAwAAAAAAAAAJTm90RnVuZGVkAAAAAAAABAAAALpgcmVmdW5kX2FmdGVyYCB3YXMgbm90IHN0cmljdGx5IGluIHRoZSBmdXR1cmUgYXQgY3JlYXRpb24g4oCUIHNlZQpkb2NzL2Fkci8wMDA0OiBhIGRlYWRsaW5lIHRoYXQgaGFzIGFscmVhZHkgcGFzc2VkIHdvdWxkIGxldAphbnlvbmUgcmVmdW5kIHRoZSBlc2Nyb3cgYmVmb3JlIHRoZSByZWxlYXNlciBjb3VsZCBldmVyIGFjdC4AAAAAABJJbnZhbGlkUmVmdW5kQWZ0ZXIAAAAAAAUAAACjVGhlIGNvbnRyYWN0J3MgdG9rZW4gYmFsYW5jZSBkaWRuJ3QgcmlzZSBieSBleGFjdGx5IGBhbW91bnRgCmFjcm9zcyBgY3JlYXRlX2VzY3Jvd2AncyB0cmFuc2ZlciAoYSBseWluZyBvciBzaG9ydC1kZWxpdmVyaW5nCnRva2VuKSDigJQgc2VlIGRvY3MvdGhyZWF0LW1vZGVsLm1kIFQ1LgAAAAAPQmFsYW5jZU1pc21hdGNoAAAAAAYAAAEAYGNvbmRpdGlvbl9yZWZgIGV4Y2VlZGVkIHRoZSBtYXhpbXVtIGFsbG93ZWQgbGVuZ3RoIChjdXJyZW50bHkKNjQgYnl0ZXMpIOKAlCBzZWUgZG9jcy90aHJlYXQtbW9kZWwubWQgVDEwIGFuZCBST0FETUFQLm1kIFBoYXNlIEU1LgpCb3VuZGVkIHRvIGtlZXAgc3RvcmFnZSBhbmQgZXZlbnQgY29zdHMgcHJlZGljdGFibGU7IHJlamVjdCBhdApjcmVhdGlvbiBzbyBubyBvbi1jaGFpbiBzdG9yYWdlIGlzIHdhc3RlZCBvbiBhbiBvdmVyc2l6ZWQgcmVmLgAAABNDb25kaXRpb25SZWZUb29Mb25nAAAAAAcAAAA2YHRva2VuYCBpcyBub3QgaW4gdGhlIGltbXV0YWJsZSBkZXBsb3ktdGltZSBhbGxvd2xpc3QuAAAAAAAPRGlzYWxsb3dlZFRva2VuAAAAAAgAAACDVGhlIG9wdGVkLWluIHBheWVlIGNhbGxiYWNrIHJldHVybmVkIGFuIGVycm9yIG9yIGNvdWxkIG5vdCBiZQppbnZva2VkLiBUaGUgcmVsZWFzZSB0cmFuc2FjdGlvbiAoaW5jbHVkaW5nIGl0cyB0cmFuc2Zlcikgcm9sbHMgYmFjay4AAAAADkNhbGxiYWNrRmFpbGVkAAAAAAAJAAAAAAAAAAhPdmVyZmxvdwAAAAwAAABsVGhlIHJlbGVhc2VyIHNldCBpcyBlbXB0eSwgb3IgYHRocmVzaG9sZGAgaXMgMCBvciBsYXJnZXIgdGhhbiB0aGUKbnVtYmVyIG9mIHJlbGVhc2VycyDigJQgc2VlIGRvY3MvYWRyLzAwMDcuAAAAEEludmFsaWRUaHJlc2hvbGQAAAANAAAAQ01vcmUgdGhhbiBgTUFYX1JFTEVBU0VSU2AgKDEwKSBhZGRyZXNzZXMgd2VyZSBzdXBwbGllZCBhdCBjcmVhdGlvbi4AAAAAEFRvb01hbnlSZWxlYXNlcnMAAAAOAAAAn0Zld2VyIGRpc3RpbmN0IGFwcHJvdmFscyB3ZXJlIHN1cHBsaWVkIHRoYW4gdGhlIGVzY3JvdydzIHRocmVzaG9sZCwKb3IgYSBzaW5nbGUgcmVsZWFzZXIgdHJpZWQgdG8gc2V0dGxlIGEgcXVvcnVtIGVzY3JvdyB0aHJvdWdoIHRoZQpzaW5nbGUtY2FsbGVyIGVudHJ5IHBvaW50LgAAAAAPVGhyZXNob2xkTm90TWV0AAAAAA8AAABoVGhlIHNhbWUgYWRkcmVzcyBhcHBlYXJlZCB0d2ljZSBpbiBvbmUgYXBwcm92YWwgbGlzdC4gRHVwbGljYXRlcwpuZXZlciBjb3VudCB0d2ljZSB0b3dhcmQgdGhlIHRocmVzaG9sZC4AAAARRHVwbGljYXRlQXBwcm92ZXIAAAAAAAAQAAAAQFRoZSBzYW1lIGFkZHJlc3MgYXBwZWFyZWQgdHdpY2UgaW4gdGhlIHJlbGVhc2VyIHNldCBhdCBjcmVhdGlvbi4AAAARRHVwbGljYXRlUmVsZWFzZXIAAAAAAAARAAAAAAAAABJBY2NlcHRhbmNlUmVxdWlyZWQAAAAAABIAAAAAAAAAF0FjY2VwdGFuY2VOb3RDb25maWd1cmVkAAAAABMAAAAAAAAAD0FscmVhZHlBY2NlcHRlZAAAAAAUAAAAOFRoZSBuZXcgcmVsZWFzZXIgY2Fubm90IGJlIHRoZSBlc2Nyb3cgY29udHJhY3Qgb3IgcGF5ZWUuAAAAD0ludmFsaWRSZWxlYXNlcgAAAAAYAAAAfGByZWZ1bmRfdG9gIHdhcyB0aGUgZXNjcm93IGNvbnRyYWN0J3Mgb3duIGFkZHJlc3Mg4oCUIGZ1bmRzIHNlbnQKdGhlcmUgb24gcmVmdW5kIGNvdWxkIG5ldmVyIGJlIG1vdmVkIGFnYWluIChkb2NzL2Fkci8wMDA5KS4AAAAPSW52YWxpZFJlZnVuZFRvAAAAABUAAABEVGhlIGNvbmZpZ3VyZWQgcmVsZWFzZSB0aW1lIGlzIGluIHRoZSBwYXN0IG9yIGFmdGVyIHRoZSByZWZ1bmQgdGltZS4AAAAXSW52YWxpZFJlbGVhc2VOb3RCZWZvcmUAAAAAFgAAADFSZWxlYXNlIHdhcyBhdHRlbXB0ZWQgYmVmb3JlIHRoZSBjb25maWd1cmVkIHRpbWUuAAAAAAAAD1JlbGVhc2VUb29FYXJseQAAAAAXAAAArUEgYmF0Y2ggY2FsbCB3YXMgcGFzc2VkIG1vcmUgdGhhbiBgTUFYX0JBVENIX1NJWkVgIGl0ZW1zIOKAlCBzZWUKZG9jcy9hZHIvMDAwNS4gQ2FsbGVycyBtdXN0IGNodW5rLiBBcHBlbmRlZCBhdCB0aGUgZW5kIHNvIGV4aXN0aW5nCmRpc2NyaW1pbmFudHMga2VlcCB0aGVpciBvbi1jaGFpbiB2YWx1ZXMuAAAAAAAADUJhdGNoVG9vTGFyZ2UAAAAAAAAZAAAAiGBjb250cmlidXRlYC9gY2xhaW1fcmVmdW5kYC9gZ2V0X2NvbnRyaWJ1dGlvbmAgb24gYSBub24tcG9vbGVkCmVzY3Jvdywgb3IgYGdldF9wb29sZWRgIG9uIGEgbm9uLXBvb2xlZC91bmtub3duIGlkIOKAlCBzZWUKZG9jcy9hZHIvMDAxMS4AAAAJTm90UG9vbGVkAAAAAAAAGgAAAL9BIGNvbnRyaWJ1dGlvbiBhcnJpdmVkIGFmdGVyIHRoZSBwb29sZWQgZXNjcm93J3MgZnVuZGluZyBkZWFkbGluZS4KTGF0ZSBjb250cmlidXRpb25zIGNhbiBuZXZlciBiZSBhY2NlcHRlZDogdGhlIHJvdW5kJ3Mgb3V0Y29tZQoocmVsZWFzZSB2cyBwZXItY29udHJpYnV0b3IgcmVmdW5kcykgaXMgZml4ZWQgYXQgdGhlIGRlYWRsaW5lLgAAAAAVRnVuZGluZ0RlYWRsaW5lUGFzc2VkAAAAAAAAGwAAAL9BIGNvbnRyaWJ1dGlvbiB3b3VsZCBwdXNoIHRoZSBwb29sZWQgdG90YWwgcGFzdCB0aGUgZnVuZGluZyB0YXJnZXQKKG92ZXJmdW5kaW5nIGlzIHJlamVjdGVkLCBub3QgYWNjZXB0ZWQpLCB0aGUgdGFyZ2V0IGlzIGFscmVhZHkgbWV0LApvciBhIHJlZnVuZCB3YXMgY2xhaW1lZCBvbiBhIGZ1bGx5IGZ1bmRlZCBwb29sZWQgZXNjcm93LgAAAAAURnVuZGluZ1RhcmdldFJlYWNoZWQAAAAcAAAAdGByZWxlYXNlYCBvbiBhIHBvb2xlZCBlc2Nyb3cgd2hvc2UgZnVuZGVkIHRvdGFsIGlzIGJlbG93IHRoZQpmdW5kaW5nIHRhcmdldCDigJQgcGFydGlhbCBmdW5kaW5nIGlzIG5ldmVyIHJlbGVhc2FibGUuAAAAEUZ1bmRpbmdJbmNvbXBsZXRlAAAAAAAAHQAAAIZgY2xhaW1fcmVmdW5kYCBiZWZvcmUgdGhlIGZ1bmRpbmcgZGVhZGxpbmUgcGFzc2VkIG9uIGEgcm91bmQgdGhhdAppcyBzdGlsbCAob3Igbm93IGZ1bGx5KSBmdW5kZWQuIENsYWltcyBvcGVuIG9ubHkgZm9yIGEgZmFpbGVkIHJvdW5kLgAAAAAADVJlZnVuZE5vdE9wZW4AAAAAAAAeAAAAM1RoZSBzYW1lIGNvbnRyaWJ1dG9yIHRyaWVkIHRvIGNsYWltIGEgcmVmdW5kIHR3aWNlLgAAAAAPQWxyZWFkeVJlZnVuZGVkAAAAAB8AAAA7YGNsYWltX3JlZnVuZGAgYnkgYW4gYWRkcmVzcyB3aXRoIG5vIHJlY29yZGVkIGNvbnRyaWJ1dGlvbi4AAAAADk5vQ29udHJpYnV0aW9uAAAAAAAgAAAA82ByZWZ1bmRgL2ByZWZ1bmRfd2l0aF9hcHByb3ZhbHNgL2BjYW5jZWxgL2B0b3BfdXBgIG9uIGEgcG9vbGVkCmVzY3JvdzogcHVzaGluZyB0aGUgd2hvbGUgcG9vbGVkIHRvdGFsIHRvIG9uZSBhZGRyZXNzIHdvdWxkIHZpb2xhdGUKcGVyLWNvbnRyaWJ1dG9yIGFjY291bnRpbmcuIFBvb2xlZCByZWZ1bmRzIGFyZSBwdWxsLWJhc2VkCihgY2xhaW1fcmVmdW5kYCk7IHBvb2xlZCBmdW5kaW5nIGlzIGBjb250cmlidXRlYC1vbmx5LgAAAAAVTm90U3VwcG9ydGVkRm9yUG9vbGVkAAAAAAAAIQAAAEBUaGUgZnVuZGluZyBkZWFkbGluZSB3YXMgbm90IHN0cmljdGx5IGluIHRoZSBmdXR1cmUgYXQgY3JlYXRpb24uAAAAFkludmFsaWRGdW5kaW5nRGVhZGxpbmUAAAAAACI=",
        "AAAAAQAAAHJPbmUgZW50cnkgb2YgYSBgY3JlYXRlX2VzY3Jvd3NgIGJhdGNoLiBNaXJyb3JzIHRoZSBzaW5nbGUtZXNjcm93CmNyZWF0aW9uIHBhcmFtZXRlcnMgbWludXMgdGhlIGJhdGNoLXdpZGUgYHBheWVyYC4AAAAAAAAAAAAKQ3JlYXRlSXRlbQAAAAAABgAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAA1jb25kaXRpb25fcmVmAAAAAAAAEAAAAAAAAAAFcGF5ZWUAAAAAAAATAAAAAAAAAAxyZWZ1bmRfYWZ0ZXIAAAPoAAAABgAAAAAAAAAIcmVsZWFzZXIAAAATAAAAAAAAAAV0b2tlbgAAAAAAABM=",
        "AAAAAQAAAAAAAAAAAAAACkVzY3Jvd0RhdGEAAAAAAA4AAAA1TGVkZ2VyIHRpbWVzdGFtcCBhdCB3aGljaCB0aGUgcGF5ZWUgYWNjZXB0ZWQsIGlmIGFueS4AAAAAAAALYWNjZXB0ZWRfYXQAAAAD6AAAAAYAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAANY29uZGl0aW9uX3JlZgAAAAAAABAAAACGSWYgdHJ1ZSwgaW52b2tlIHRoZSBjb250cmFjdCBwYXllZSdzIGBvbl9lc2Nyb3dfcmVsZWFzZWRgIGhvb2sgYWZ0ZXIKdGhlIHBheW91dCB0cmFuc2Zlci4gQSBmYWlsZWQgY2FsbGJhY2sgcmV2ZXJ0cyB0aGUgd2hvbGUgcmVsZWFzZS4AAAAAAAxub3RpZnlfcGF5ZWUAAAABAAAAAAAAAAVwYXllZQAAAAAAABMAAAB6VGhlIGZ1bmRlcjogYXV0aG9yaXNlcyBhbmQgcGF5cyBmb3IgdGhlIGVzY3JvdyBhdCBjcmVhdGlvbi4gQWxzbwp0aGUgcmVmdW5kIGRlc3RpbmF0aW9uIHVubGVzcyBgcmVmdW5kX3RvYCBzYXlzIG90aGVyd2lzZS4AAAAAAAVwYXllcgAAAAAAABMAAADFT3B0aW9uYWwgZGVhZGxpbmUgKHVuaXggc2Vjb25kcykgYWZ0ZXIgd2hpY2ggYHJlZnVuZGAgb3BlbnMgdG8KYW55b25lIOKAlCBzdGlsbCBvbmx5IHRvIGByZWZ1bmRfdG9gLiBgTm9uZWAgbWVhbnMgbm8gdGltZW91dCwKYmVoYXZpb3VyIGlkZW50aWNhbCB0byBiZWZvcmUgdGhpcyBmaWVsZCBleGlzdGVkIOKAlCBzZWUgZG9jcy9hZHIvMDAwNC4AAAAAAAAMcmVmdW5kX2FmdGVyAAAD6AAAAAYAAADhV2hlcmUgKipldmVyeSoqIHJlZnVuZCBwYXRoIChyZWxlYXNlciwgdGltZW91dCkgc2VuZHMgdGhlIGZ1bmRzLgpGaXhlZCBhdCBjcmVhdGlvbiB1bmRlciB0aGUgZnVuZGVyJ3MgYXV0aCBhbmQgbmV2ZXIgY2hvc2VuIGF0CnBheW91dCwgc28gaW52YXJpYW50IEkxIGhvbGRzOyBkZWZhdWx0cyB0byBgcGF5ZXJgIHdoZW4gb21pdHRlZCBhdApjcmVhdGlvbiDigJQgc2VlIGRvY3MvYWRyLzAwMDkuAAAAAAAACXJlZnVuZF90bwAAAAAAABMAAAA2RWFybGllc3QgbGVkZ2VyIHRpbWVzdGFtcCBhdCB3aGljaCByZWxlYXNlIGlzIGFsbG93ZWQuAAAAAAAScmVsZWFzZV9ub3RfYmVmb3JlAAAAAAPoAAAABgAAAL1BZGRyZXNzZXMgcGVybWl0dGVkIHRvIHNldHRsZSB0aGlzIGVzY3JvdyDigJQgc2VlIGRvY3MvYWRyLzAwMDIgZm9yIHRoZQpwZXItZXNjcm93IHJlbGVhc2VyLCBhbmQgZG9jcy9hZHIvMDAwNyBmb3IgTS1vZi1OIHNldHMuIEEgcGxhaW4Kc2luZ2xlLXJlbGVhc2VyIGVzY3JvdyBzdG9yZXMgZXhhY3RseSBvbmUgZW50cnkgaGVyZS4AAAAAAAAJcmVsZWFzZXJzAAAAAAAD6gAAABMAAAA5V2hldGhlciByZWxlYXNlIHJlcXVpcmVzIHRoZSBwYXllZSdzIGV4cGxpY2l0IGFjY2VwdGFuY2UuAAAAAAAAE3JlcXVpcmVzX2FjY2VwdGFuY2UAAAAAAQAAAAAAAAAGc3RhdHVzAAAAAAfQAAAADEVzY3Jvd1N0YXR1cwAAALpIb3cgbWFueSAqZGlzdGluY3QqIGFkZHJlc3NlcyBmcm9tIGByZWxlYXNlcnNgIG11c3QgYXV0aG9yaXplIG9uZQpzZXR0bGVtZW50LiBBbHdheXMgYD49IDFgIGFuZCBgPD0gcmVsZWFzZXJzLmxlbigpYDsgYDFgIG1lYW5zIGFueQpzaW5nbGUgcmVsZWFzZXIgY2FuIHNldHRsZSAodGhlIHByZS1xdW9ydW0gYmVoYXZpb3VyKS4AAAAAAAl0aHJlc2hvbGQAAAAAAAAEAAAAAAAAAAV0b2tlbgAAAAAAABM=",
        "AAAAAQAAAYBPbmUgZW50cnkgb2YgYSBgY3JlYXRlX2VzY3Jvd3NgIGJhdGNoLiBNaXJyb3JzIHRoZSBzaW5nbGUtZXNjcm93CmNyZWF0aW9uIHBhcmFtZXRlcnMgbWludXMgdGhlIGJhdGNoLXdpZGUgYHBheWVyYC4KSW1tdXRhYmxlIGZ1bmRpbmcgY29uZmlndXJhdGlvbiBvZiBhIHBvb2xlZCBlc2Nyb3cgKGlzc3VlICMxMTMsCmRvY3MvYWRyLzAwMTEpLiBFeGlzdGVuY2Ugb2YgdGhpcyByZWNvcmQgdW5kZXIgYERhdGFLZXk6OlBvb2xlZChpZClgIGlzCndoYXQgbWFrZXMgYW4gZXNjcm93ICJwb29sZWQiOyB0aGUgYWdncmVnYXRlIGZ1bmRlZCBhbW91bnQgbGl2ZXMgaW4KYEVzY3Jvd0RhdGEuYW1vdW50YCAob25lIHNvdXJjZSBvZiB0cnV0aCBzaGFyZWQgd2l0aCBgc2V0dGxlKClgKS4AAAAAAAAAClBvb2xlZERhdGEAAAAAAAIAAAEJVW5peCBzZWNvbmRzIHVudGlsIHdoaWNoIGBjb250cmlidXRlYCBpcyBhY2NlcHRlZC4gV2hlbiBpdCBwYXNzZXMKd2l0aCB0aGUgdGFyZ2V0IHVubWV0LCB0aGUgcm91bmQgaGFzIGZhaWxlZDogY29udHJpYnV0aW9ucyBhcmUKZnJvemVuIGZvcmV2ZXIgYW5kIGV2ZXJ5IGNvbnRyaWJ1dG9yIG1heSBwdWxsIHRoZWlyIGV4YWN0IHJlY29yZGVkCmFtb3VudCBiYWNrIHdpdGggYGNsYWltX3JlZnVuZGAg4oCUIHRoZSBlc2Nyb3cgY2FuIG5ldmVyIGJlIHJlbGVhc2VkLgAAAAAAABBmdW5kaW5nX2RlYWRsaW5lAAAABgAAAIFUb3RhbCB0aGUgY29udHJpYnV0b3JzIG11c3QgcmVhY2ggZm9yIHJlbGVhc2UgdG8gYmVjb21lIHBvc3NpYmxlLgpTdHJpY3RseSBwb3NpdGl2ZSwgZml4ZWQgYXQgY3JlYXRpb24sIG5ldmVyIGNoYW5nZWQgYWZ0ZXJ3YXJkcy4AAAAAAAAOZnVuZGluZ190YXJnZXQAAAAAAAs=",
        "AAAAAQAAAUdPbmUgcGF5ZXIncyByZWNvcmQgb24gYSBwb29sZWQgZXNjcm93IChpc3N1ZSAjMTEzLCBkb2NzL2Fkci8wMDExKS4KYGFtb3VudGAgYWNjdW11bGF0ZXMgZXZlcnkgYWNjZXB0ZWQgY29udHJpYnV0aW9uIGZyb20gdGhhdCBwYXllcjsKYHJlZnVuZGVkYCBpcyB0aGUgY2xhaW0tY29tcGxldGlvbiBtYXJrZXIgdGhhdCBtYWtlcyBhIHNlY29uZCBwYXlvdXQKaW1wb3NzaWJsZS4gUmVjb3JkcyBhcmUgb25seSBldmVyIHdyaXR0ZW4gYnkgYGNvbnRyaWJ1dGVgIGFuZApgY2xhaW1fcmVmdW5kYCwgZWFjaCB1bmRlciB0aGUgY29udHJpYnV0b3IncyBvd24gYXV0aG9yaXphdGlvbi4AAAAAAAAAAAxDb250cmlidXRpb24AAAACAAAAAAAAAAZhbW91bnQAAAAAAAsAAAAAAAAACHJlZnVuZGVkAAAAAQ==",
        "AAAAAgAAAAAAAAAAAAAADEVzY3Jvd1N0YXR1cwAAAAQAAAAAAAAAAAAAAAZGdW5kZWQAAAAAAAAAAAAAAAAACFJlbGVhc2VkAAAAAAAAAAAAAAAIUmVmdW5kZWQAAAAAAAAAd1RoZSBwYXllciB3aXRoZHJldyB0aGUgZnVuZHMgYmVmb3JlIHRoZSBwYXllZSBhY2NlcHRlZCDigJQgc2VlCmRvY3MvYWRyLzAwMTAuIFRlcm1pbmFsLCBsaWtlIGBSZWxlYXNlZGAgYW5kIGBSZWZ1bmRlZGAuAAAAAAlDYW5jZWxsZWQAAAA=",
        "AAAAAQAAAK1UaGUgb25seSBzdGF0ZSBrZXB0IGZvciBhIHNldHRsZWQgZXNjcm93IChkb2NzL2Fkci8wMDEyKS4gSXRzIHBhcnRpZXMsCnRva2VuLCBhbW91bnQgYW5kIHJlbGVhc2VycyBsaXZlIGluIHRoZSBzZXR0bGVtZW50IGV2ZW50CihgcHVibGlzaF9zdGF0ZWApLCBub3QgaW4gcGVyc2lzdGVudCBzdG9yYWdlLgAAAAAAAAAAAAANU2V0dGxlZEVzY3JvdwAAAAAAAAEAAAAAAAAABnN0YXR1cwAAAAAH0AAAAAxFc2Nyb3dTdGF0dXM=",
        "AAAAAAAAAD1SZWNvcmRzIHRoZSBwYXllZSdzIGFjY2VwdGFuY2UgZm9yIGFuIG9wdGVkLWluIGZ1bmRlZCBlc2Nyb3cuAAAAAAAABmFjY2VwdAAAAAAAAgAAAAAAAAAJZXNjcm93X2lkAAAAAAAABgAAAAAAAAAFcGF5ZWUAAAAAAAATAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAA5dMZXRzIHRoZSBwYXllciB0YWtlIHRoZSBmdW5kcyBiYWNrICoqYmVmb3JlIHRoZSBwYXllZSBhY2NlcHRzKioKKGRvY3MvYWRyLzAwMTApOiByZXR1cm5zIHRoZSBlc2Nyb3dlZCBgYW1vdW50YCB0byBgcmVmdW5kX3RvYCAodGhlCmBwYXllcmAgdW5sZXNzIGEgc3BvbnNvciBkZXN0aW5hdGlvbiB3YXMgZml4ZWQgYXQgY3JlYXRpb24sIEFEUgowMDA5KSBhbmQgbWFya3MgdGhlIGVzY3JvdyBgQ2FuY2VsbGVkYC4gQWxsb3dlZCBvbmx5IHdoaWxlICoqYWxsKioKaG9sZDoKCi0gYHBheWVyYCBpcyB0aGUgZXNjcm93J3Mgc3RvcmVkIHBheWVyIGFuZCBhdXRob3JpemVzIHRoZSBjYWxsOwotIHRoZSBlc2Nyb3cgaXMgc3RpbGwgYEZ1bmRlZGAgKGBOb3RGdW5kZWRgIG90aGVyd2lzZSDigJQgbmV2ZXIgYWZ0ZXIKYSByZWxlYXNlLCByZWZ1bmQgb3IgZWFybGllciBjYW5jZWwpOwotIGl0IHdhcyBjcmVhdGVkIHdpdGggYHJlcXVpcmVzX2FjY2VwdGFuY2VgCihgQWNjZXB0YW5jZU5vdENvbmZpZ3VyZWRgIG90aGVyd2lzZSDigJQgd2l0aG91dCB0aGUgZ2F0ZSB0aGVyZSBpcwpubyBhY2NlcHRhbmNlIHN0ZXAgdG8gcmFjZSwgc28gbm8gY2FuY2VsIHdpbmRvdyBleGlzdHMpOwotIHRoZSBwYXllZSBoYXMgbm90IGFjY2VwdGVkIChgQWxyZWFkeUFjY2VwdGVkYCBvdGhlcndpc2UpLgoKVGhlIGRlc3RpbmF0aW9uIGlzIHJlYWQgZnJvbSBzdG9yYWdlLCBzbyBpbnZhcmlhbnQgSTEgaXMgdW5jaGFuZ2VkLgpQYXllZXM6IGRvIG5vdCByZWx5IG9uIGEgYHJlcXVpcmVzX2FjY2VwdGFuY2VgIGVzY3JvdyB1bnRpbCB5b3UKaGF2ZSBjYWxsZWQgYGFjY2VwdGAuIGBhY2NlcHRgIGFuZCBgY2FuY2VsYCByYWNlIG9uIG9uZSBsZWRnZXIKc3RhdGU6IHdoaWNoZXZlciBsYW5kcyBmaXJzdCB3aW5zIGFuZCB0aGUgb3RoZXIgZmFpbHMuAAAAAAZjYW5jZWwAAAAAAAIAAAAAAAAACWVzY3Jvd19pZAAAAAAAAAYAAAAAAAAABXBheWVyAAAAAAAAEwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAwlSZXR1cm5zIHRoZSBlc2Nyb3dlZCBgYW1vdW50YCB0byB0aGUgZXNjcm93J3MgYHJlZnVuZF90b2AgKHRoZQpgcGF5ZXJgIHVubGVzcyBhIGRpZmZlcmVudCBkZXN0aW5hdGlvbiB3YXMgZml4ZWQgYXQgY3JlYXRpb24g4oCUCmRvY3MvYWRyLzAwMDYpLiBTYW1lIHN0YXRlIHJ1bGUgYXMKYHJlbGVhc2VgIChvbmx5IHdoaWxlIGBGdW5kZWRgKSwgYnV0IHR3byBjYWxsZXJzIGFyZSBhdXRob3Jpc2VkOgoKLSB0aGUgZXNjcm93J3MgcmVsZWFzZXIgKGRvY3MvYWRyLzAwMDIpLCBhbHdheXM7IG9yCi0gKiphbnlvbmUqKiwgb25jZSBgcmVmdW5kX2FmdGVyYCBoYXMgYmVlbiByZWFjaGVkIOKAlCB0aGUgdGltZW91dApyZWZ1bmQgcGF0aCBmb3IgYSBsb3N0L3Vuc2lnbmFibGUgcmVsZWFzZXIga2V5IChkb2NzL2Fkci8wMDA0KS4KClRoZSBkZXN0aW5hdGlvbiBuZXZlciBjaGFuZ2VzOiB0aW1lb3V0IG9yIG5vdCwgZnVuZHMgb25seSBldmVyIGdvCnRvIHRoZSBzdG9yZWQgYHJlZnVuZF90b2AsIHdoaWNoIG5vIGNhbGxlciBjYW4gaW5mbHVlbmNlLiBXaXRoIG5vCmByZWZ1bmRfYWZ0ZXJgIHNldCwgYmVoYXZpb3VyIGlzIGlkZW50aWNhbCB0byBiZWZvcmUgdGhlIHRpbWVvdXQKZXhpc3RlZCDigJQgcmVsZWFzZXIgb25seS4gT24gYW4gTS1vZi1OIGVzY3JvdyB0aGUgcmVsZWFzZXIgcGF0aCBuZWVkcwphIHRocmVzaG9sZCBvZiAxOyBvdGhlcndpc2UgdXNlIGByZWZ1bmRfd2l0aF9hcHByb3ZhbHNgICh0aGUgdGltZW91dApwYXRoIHN0YXlzIG9wZW4gdG8gYW55b25lKS4AAAAAAAAGcmVmdW5kAAAAAAACAAAAAAAAAAllc2Nyb3dfaWQAAAAAAAAGAAAAAAAAAAZjYWxsZXIAAAAAABMAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAHVBZGRzIGZ1bmRzIHRvIGEgZnVuZGVkIGVzY3JvdyB3aXRob3V0IGNoYW5naW5nIGl0cyBwYXJ0aWVzIG9yIGlkLgpPbmx5IGl0cyBvcmlnaW5hbCBwYXllciBtYXkgYXV0aG9yaXplIHRoZSB0cmFuc2Zlci4AAAAAAAAGdG9wX3VwAAAAAAADAAAAAAAAAAllc2Nyb3dfaWQAAAAAAAAGAAAAAAAAAAVwYXllcgAAAAAAABMAAAAAAAAABmFtb3VudAAAAAAACwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAcxNb3ZlcyB0aGUgZXNjcm93ZWQgYGFtb3VudGAgdG8gYHBheWVlYC4gT25seSB0aGUgZXNjcm93J3MgcmVsZWFzZXIKbWF5IGNhbGwgdGhpcyDigJQgdGhlIGNvbnRyYWN0IGVuZm9yY2VzIFdITywgbmV2ZXIgV0hZIChBRFIgMDAwMSkuIE9uCmFuIE0tb2YtTiBlc2Nyb3cgdGhpcyBzaW5nbGUtY2FsbGVyIHBhdGggaXMgb25seSBhbGxvd2VkIHdoZW4gdGhlCnRocmVzaG9sZCBpcyAxOyBvdGhlcndpc2UgdXNlIGByZWxlYXNlX3dpdGhfYXBwcm92YWxzYC4KCkRlbGliZXJhdGVseSAqKm5vdCoqIGdhdGVkIGJ5IGByZWZ1bmRfYWZ0ZXJgIChkb2NzL2Fkci8wMDA0KTogYWZ0ZXIKdGhlIGRlYWRsaW5lIHRoZSByZWxlYXNlciBjYW4gc3RpbGwgcmVsZWFzZSwgcmFjaW5nIGFueSB0aW1lb3V0CnJlZnVuZCDigJQgd2hvZXZlciBsYW5kcyBmaXJzdCB3aW5zIGFuZCB0aGUgb3RoZXIgZmFpbHMgYE5vdEZ1bmRlZGAuAAAAB3JlbGVhc2UAAAAAAgAAAAAAAAAJZXNjcm93X2lkAAAAAAAABgAAAAAAAAAGY2FsbGVyAAAAAAATAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAA65BZGRzIGBhbW91bnRgIHRvIGEgcG9vbGVkIGVzY3JvdyBmcm9tIGBwYXllcmAgKGlzc3VlICMxMTMsCmRvY3MvYWRyLzAwMTEpLiBQZXJtaXNzaW9ubGVzcyDigJQgYW55b25lIG1heSBmdW5kIOKAlCBidXQgZXZlcnkKY29udHJpYnV0aW9uOgotIG11c3QgYmUgYSBwb3NpdGl2ZSBhbW91bnQgKGBJbnZhbGlkQW1vdW50YCk7Ci0gaXMgYWNjZXB0ZWQgb25seSB3aGlsZSB0aGUgZXNjcm93IGlzIGBGdW5kZWRgIGFuZCB0aGUgbGVkZ2VyCnRpbWVzdGFtcCBpcyBzdHJpY3RseSBiZWZvcmUgdGhlIGZ1bmRpbmcgZGVhZGxpbmUKKGBGdW5kaW5nRGVhZGxpbmVQYXNzZWRgIGFmdGVyIGl0IOKAlCBsYXRlIG1vbmV5IGNhbiBuZXZlciBjaGFuZ2UgYQpyb3VuZCdzIG91dGNvbWUpOwotIG1heSBub3QgcHVzaCB0aGUgcG9vbGVkIHRvdGFsIHBhc3QgdGhlIGZ1bmRpbmcgdGFyZ2V0CihgRnVuZGluZ1RhcmdldFJlYWNoZWRgIOKAlCBvdmVyZnVuZGluZyBpcyByZWplY3RlZCwgbm90IHJlZnVuZGVkKTsKLSBpcyBwdWxsZWQgZnJvbSBgcGF5ZXJgIHVuZGVyIGBwYXllci5yZXF1aXJlX2F1dGgoKWAgYW5kIHZlcmlmaWVkCndpdGggdGhlIHNhbWUgZXhhY3QgYmFsYW5jZS1kZWx0YSBjaGVjayBhcyBjcmVhdGlvbgooYEJhbGFuY2VNaXNtYXRjaGAgaWYgdGhlIGNvbnRyYWN0J3MgYmFsYW5jZSBkaWRuJ3QgcmlzZSBieQpleGFjdGx5IGBhbW91bnRgKTsKLSBpcyByZWNvcmRlZCBhZ2FpbnN0IGBwYXllcmAgb25seSwgYWNjdW11bGF0aW5nIGFjcm9zcyByZXBlYXRlZApjb250cmlidXRpb25zIGFuZCBuZXZlciB0b3VjaGluZyBvdGhlciBwYXllcnMnIHJlY29yZHMuCkFjY291bnRpbmcgaXMgdXBkYXRlZCBvbmx5IGFmdGVyIHRoZSB0cmFuc2ZlciBpcyB2ZXJpZmllZCwgc28gYQpmYWlsZWQgY29udHJpYnV0aW9uIHJlY29yZHMgbm90aGluZyAoaW52YXJpYW50IEk0KS4AAAAAAApjb250cmlidXRlAAAAAAADAAAAAAAAAAllc2Nyb3dfaWQAAAAAAAAGAAAAAAAAAAVwYXllcgAAAAAAABMAAAAAAAAABmFtb3VudAAAAAAACwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAhtSZWFkLW9ubHkgYWNjZXNzb3IgZm9yIGV2ZXJ5dGhpbmcgc3RvcmVkIGFib3V0IGBlc2Nyb3dfaWRgIOKAlCBwYXllciwKcGF5ZWUsIHRva2VuLCBhbW91bnQsIGBjb25kaXRpb25fcmVmYCwgc3RhdHVzLCB0aGUgcmVsZWFzZXIgc2V0IHdpdGgKaXRzIHRocmVzaG9sZCwgYHJlZnVuZF9hZnRlcmAgYW5kIGByZWZ1bmRfdG9gLiBFeGlzdHMgc28gcGF5ZWVzIGFuZAppbnRlZ3JhdG9ycyBjYW4gY2hlY2sgd2hvIGNhbiBzZXR0bGUsIHdoZW4sIGFuZCB3aGVyZSBhIHJlZnVuZCBnb2VzCmJlZm9yZSByZWx5aW5nIG9uIGEgYEZ1bmRlZGAgZXNjcm93IChkb2NzL2Fkci8wMDA0LCB0aHJlYXQgbW9kZWwgVDgpLgpPbmx5IGBGdW5kZWRgIGVzY3Jvd3MgaGF2ZSBhIGZ1bGwgcmVjb3JkOiBvbmNlIHNldHRsZWQgaXQgaXMgcmVjbGFpbWVkCihkb2NzL2Fkci8wMDEyKSBhbmQgdGhpcyByZXR1cm5zIGBOb3RGb3VuZGAg4oCUIHVzZSBgZ2V0X3N0YXR1c2AgZm9yIGEKc2V0dGxlZCBpZCBhbmQgdGhlIHNldHRsZW1lbnQgZXZlbnQgZm9yIGl0cyBoaXN0b3J5LgAAAAAKZ2V0X2VzY3JvdwAAAAAAAQAAAAAAAAAJZXNjcm93X2lkAAAAAAAABgAAAAEAAAPpAAAH0AAAAApFc2Nyb3dEYXRhAAAAAAAD",
        "AAAAAAAAATdSZWFkLW9ubHk6IHRoZSBpbW11dGFibGUgZnVuZGluZyBjb25maWcgb2YgYSBwb29sZWQgZXNjcm93LiBUaGUKYWdncmVnYXRlIGZ1bmRlZCBhbW91bnQgaXMgdGhlIGVzY3JvdydzIGBhbW91bnRgIGZyb20gYGdldF9lc2Nyb3dgOwphIHJvdW5kIGlzIGZhaWxlZCB3aGVuIGBub3cgPj0gZnVuZGluZ19kZWFkbGluZWAgYW5kIGBhbW91bnQgPApmdW5kaW5nX3RhcmdldGAgKHRoZW4gYGNsYWltX3JlZnVuZGAgaXMgb3BlbiB0byBlYWNoIGNvbnRyaWJ1dG9yKS4KRXJyb3JzIGBOb3RQb29sZWRgIG9uIGEgbm9uLXBvb2xlZCBvciB1bmtub3duIGlkLgAAAAAKZ2V0X3Bvb2xlZAAAAAAAAQAAAAAAAAAJZXNjcm93X2lkAAAAAAAABgAAAAEAAAPpAAAH0AAAAApQb29sZWREYXRhAAAAAAAD",
        "AAAAAAAAALFSZWFkLW9ubHkgc3RhdHVzIHF1ZXJ5LiBBbnN3ZXJzIGZvciBzZXR0bGVkIGVzY3Jvd3MgdG9vLCBmcm9tIHRoZQp0b21ic3RvbmUgbGVmdCBvbiBzZXR0bGVtZW50IChkb2NzL2Fkci8wMDEyKSwgc28gYE5vdEZvdW5kYCBtZWFucwpleGFjdGx5IG9uZSB0aGluZzogdGhpcyBpZCB3YXMgbmV2ZXIgY3JlYXRlZC4AAAAAAAAKZ2V0X3N0YXR1cwAAAAAAAQAAAAAAAAAJZXNjcm93X2lkAAAAAAAABgAAAAEAAAPpAAAH0AAAAAxFc2Nyb3dTdGF0dXMAAAAD",
        "AAAAAAAAAhBCYXRjaCB2ZXJzaW9uIG9mIGByZWxlYXNlYDogcmVsZWFzZXMgZWFjaCBlc2Nyb3cgaW4gYGVzY3Jvd19pZHNgIGluCm9yZGVyIG9uIGJlaGFsZiBvZiBgY2FsbGVyYCwgd2hpY2ggbXVzdCBiZSBhIHJlbGVhc2VyIG9mIGV2ZXJ5IG9uZQpvZiB0aGVtLiBSZXR1cm5zIGEgcGVyLW9wIHJlc3VsdCB2ZWN0b3IgYWxpZ25lZCB3aXRoIGBlc2Nyb3dfaWRzYDoKYE9rKCgpKWAgZm9yIGEgc3VjY2Vzc2Z1bCByZWxlYXNlLCBgRXJyKGUpYCBmb3Igb25lIHRoZSBjb250cmFjdApyZWplY3RlZCAodW5rbm93biBpZCwgbm90IGZ1bmRlZCwgY2FsbGVyIG5vdCBhIHJlbGVhc2VyLCBiZWZvcmUKYHJlbGVhc2Vfbm90X2JlZm9yZWApLiBBIHJlamVjdGVkIG9wIGRvZXMgbm90IHN0b3AgdGhlIHJlc3Qg4oCUIHRoZQpjYWxsZXIgY2FuIGluc3BlY3QgdGhlIHZlY3RvciBhbmQgcmV0cnkgb25seSB0aGUgZmFpbHVyZXMuCgpgZXNjcm93X2lkcy5sZW4oKWAgbXVzdCBiZSBgPD0gTUFYX0JBVENIX1NJWkVgIOKAlCBzZWUgZG9jcy9hZHIvMDAwNS4AAAALc2V0dGxlX21hbnkAAAAAAgAAAAAAAAAGY2FsbGVyAAAAAAATAAAAAAAAAAplc2Nyb3dfaWRzAAAAAAPqAAAABgAAAAEAAAPpAAAD6gAAA+kAAAACAAAAAwAAAAM=",
        "AAAAAAAAA0JQdWxsLWJhc2VkIHJlZnVuZCAoaXNzdWUgIzExMywgZG9jcy9hZHIvMDAxMSk6IHBheXMgYGNvbnRyaWJ1dG9yYApleGFjdGx5IHRoZSBhbW91bnQgcmVjb3JkZWQgYWdhaW5zdCB0aGF0IGFkZHJlc3MsIG9uY2UuIEF2YWlsYWJsZQpvbmx5IGZvciBhICpmYWlsZWQqIGZ1bmRpbmcgcm91bmQg4oCUIHRoZSBmdW5kaW5nIGRlYWRsaW5lIGhhcyBwYXNzZWQKd2l0aCB0aGUgcG9vbGVkIHRvdGFsIHN0aWxsIGJlbG93IHRoZSB0YXJnZXQgKGBSZWZ1bmROb3RPcGVuYApvdGhlcndpc2UpIOKAlCBhbmQgb25seSB3aGlsZSB0aGUgZXNjcm93IGhhcyBub3QgYmVlbiByZWxlYXNlZAooYE5vdEZ1bmRlZGAgYWZ0ZXJ3YXJkczogcmVsZWFzZWQgZnVuZHMgY2FuIG5ldmVyIGJlIGNsYWltZWQpLgpFYWNoIGNsYWltIGlzIE8oMSkgd29yayDigJQgbm8gcGF0aCBpdGVyYXRlcyBjb250cmlidXRvcnMg4oCUIGFuZCBpdHMKb3duIGF1dGhvcml6YXRpb246IG5vIG9uZSBjYW4gY2xhaW0gb24gYW5vdGhlciBjb250cmlidXRvcidzCmJlaGFsZiAoYE5vQ29udHJpYnV0aW9uYCBmb3IgYW4gYWRkcmVzcyB3aXRoIG5vIHJlY29yZCksIGEgc2Vjb25kCmNsYWltIGZhaWxzIGBBbHJlYWR5UmVmdW5kZWRgLCBhbmQgdGhlIG9yZGVyIG9mIGNsYWltcyBjYW4gbmV2ZXIKY2hhbmdlIGFueW9uZSdzIGVudGl0bGVtZW50LiBDaGVja3MtZWZmZWN0cy1pbnRlcmFjdGlvbnM6IHRoZQpgcmVmdW5kZWRgIGZsYWcgYW5kIHRoZSBwb29sZWQgdG90YWwgYXJlIHdyaXR0ZW4gYmVmb3JlIHRoZQp0cmFuc2ZlciwgYW5kIGEgZmFpbGluZyB0cmFuc2ZlciByb2xscyB0aGUgd2hvbGUgY2xhaW0gYmFjay4AAAAAAAxjbGFpbV9yZWZ1bmQAAAACAAAAAAAAAAllc2Nyb3dfaWQAAAAAAAAGAAAAAAAAAAtjb250cmlidXRvcgAAAAATAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAHtTZXRzIHRoZSBpbW11dGFibGUgdG9rZW4gYWxsb3dsaXN0IGF0IGRlcGxveW1lbnQuIEFuIGVtcHR5IGxpc3QKcHJlc2VydmVzIHRoZSBsZWdhY3kgYmVoYXZpb3IgYW5kIGFsbG93cyBhbnkgdG9rZW4gYWRkcmVzcy4AAAAADV9fY29uc3RydWN0b3IAAAAAAAABAAAAAAAAAA5hbGxvd2VkX3Rva2VucwAAAAAD6gAAABMAAAAA",
        "AAAAAAAAAw9Mb2NrcyBgYW1vdW50YCBvZiBgdG9rZW5gIHB1bGxlZCBmcm9tIGBwYXllcmAsIGhlbGQgZm9yIGBwYXllZWAsCmRvY3MvdGhyZWF0LW1vZGVsLm1kIFQxMCBhbmQgUk9BRE1BUC5tZCBQaGFzZSBFNSkuIGByZWxlYXNlcmAgaXMgdGhlCmFkZHJlc3MgcGVybWl0dGVkIHRvIGNhbGwgYHJlbGVhc2VgL2ByZWZ1bmRgIG9uIHRoaXMgZXNjcm93Cihkb2NzL2Fkci8wMDAyKS4gYHJlZnVuZF9hZnRlcmAgaXMgb3B0aW9uYWwgKGRvY3MvYWRyLzAwMDQpLgpgbm90aWZ5X3BheWVlYCBvcHRzIGFuIGltcGxlbWVudGluZyBjb250cmFjdCBwYXllZSBpbnRvCmBvbl9lc2Nyb3dfcmVsZWFzZWQoZXNjcm93X2lkLCBhbW91bnQpYCAoZG9jcy9hZHIvMDAwNSkuIFRoZSBwYXllcgptdXN0IGF1dGhvcml6ZSBjcmVhdGlvbiwgYW5kIHRoZSBwYXllZSBtdXN0IGFsc28gYXV0aG9yaXplIGlmCmBub3RpZnlfcGF5ZWVgIGlzIHRydWUuIGByZWZ1bmRfdG9gIGlzIHRoZSBvcHRpb25hbCByZWZ1bmQKZGVzdGluYXRpb24gZm9yIGEgc3BvbnNvcmVkIGVzY3JvdyB3aGVyZSB0aGUgZnVuZGVyIChgcGF5ZXJgKSBpcwpub3Qgd2hvIHNob3VsZCBnZXQgdGhlIG1vbmV5IGJhY2sgKGRvY3MvYWRyLzAwMDkpOiBgTm9uZWAgbWVhbnMKYHBheWVyYDsgaXQgbWF5IG5vdCBiZSB0aGlzIGNvbnRyYWN0J3Mgb3duIGFkZHJlc3MsIGFuZCB0aGUKYHBheWVyYCdzIGF1dGggb24gdGhpcyBjYWxsIGNvdmVycyBpdC4gRm9yIE0tb2YtTiByZWxlYXNlcnMgdXNlCmBjcmVhdGVfZXNjcm93X3dpdGhfcmVsZWFzZXJzYC4AAAAADWNyZWF0ZV9lc2Nyb3cAAAAAAAAJAAAAAAAAAAVwYXllcgAAAAAAABMAAAAAAAAABXBheWVlAAAAAAAAEwAAAAAAAAAFdG9rZW4AAAAAAAATAAAAAAAAAAZhbW91bnQAAAAAAAsAAAAAAAAADWNvbmRpdGlvbl9yZWYAAAAAAAAQAAAAAAAAAAhyZWxlYXNlcgAAABMAAAAAAAAADHJlZnVuZF9hZnRlcgAAA+gAAAAGAAAAAAAAAAxub3RpZnlfcGF5ZWUAAAABAAAAAAAAAAlyZWZ1bmRfdG8AAAAAAAPoAAAAEwAAAAEAAAPpAAAABgAAAAM=",
        "AAAAAAAAAaNCYXRjaCB2ZXJzaW9uIG9mIGBjcmVhdGVfZXNjcm93YC4gQ3JlYXRlcyBvbmUgZXNjcm93IHBlciBpdGVtLCBpbgppbnB1dCBvcmRlciwgYW5kIHJldHVybnMgdGhlIG5ldyBpZHMgaW4gdGhlIHNhbWUgb3JkZXIgYXMgYGl0ZW1zYC4KYHBheWVyYCBhdXRob3JpemVzIG9uY2UgZm9yIHRoZSB3aG9sZSBjYWxsLiBGYWlscyBhdG9taWNhbGx5OiBpZgphbnkgaXRlbSBpcyBpbnZhbGlkIChiYWQgYW1vdW50LCBwYXN0IGByZWZ1bmRfYWZ0ZXJgLCBvdmVyc2l6ZWQKYGNvbmRpdGlvbl9yZWZgLCBzaG9ydC1kZWxpdmVyaW5nIHRva2VuKSB0aGUgd2hvbGUgY2FsbCByZXZlcnRzIGFuZApubyBlc2Nyb3dzIGFyZSBjcmVhdGVkLgoKYGl0ZW1zLmxlbigpYCBtdXN0IGJlIGA8PSBNQVhfQkFUQ0hfU0laRWAg4oCUIHNlZSBkb2NzL2Fkci8wMDA1LgAAAAAOY3JlYXRlX2VzY3Jvd3MAAAAAAAIAAAAAAAAABXBheWVyAAAAAAAAEwAAAAAAAAAFaXRlbXMAAAAAAAPqAAAH0AAAAApDcmVhdGVJdGVtAAAAAAABAAAD6QAAA+oAAAAGAAAAAw==",
        "AAAAAAAAAPhSb3RhdGVzIGEgZnVuZGVkIGVzY3JvdydzIHJlbGVhc2VyLiBCb3RoIHRoZSBjdXJyZW50IHJlbGVhc2VyIGFuZApwYXllciBtdXN0IGF1dGhvcml6ZSB0aGUgY2hhbmdlOyB0aGUgcGF5ZXIncyBjb25zZW50IHByZXZlbnRzIGEKY29tcHJvbWlzZWQgcmVsZWFzZXIgZnJvbSBzaWxlbnRseSBhcHBvaW50aW5nIGFuIGF0dGFja2VyLiBUaGUKcmVwbGFjZW1lbnQgY2Fubm90IGJlIHRoZSBjb250cmFjdCBpdHNlbGYgb3IgdGhlIHBheWVlLgAAAA9yb3RhdGVfcmVsZWFzZXIAAAAAAwAAAAAAAAAJZXNjcm93X2lkAAAAAAAABgAAAAAAAAAGY2FsbGVyAAAAAAATAAAAAAAAAAxuZXdfcmVsZWFzZXIAAAATAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAARRSZWFkLW9ubHk6IG9uZSBjb250cmlidXRvcidzIHJlY29yZCBvbiBhIHBvb2xlZCBlc2Nyb3cg4oCUIHRoZSBleGFjdAphbW91bnQgdGhleSBjYW4gY2xhaW0gYmFjayBmcm9tIGEgZmFpbGVkIHJvdW5kLCBhbmQgd2hldGhlciBpdCBoYXMKYWxyZWFkeSBiZWVuIGNsYWltZWQuIGBOb25lYCBtZWFucyB0aGUgYWRkcmVzcyBuZXZlciBjb250cmlidXRlZC4KRXJyb3JzIGBOb3RGb3VuZGAgb24gYW4gdW5rbm93biBpZCBhbmQgYE5vdFBvb2xlZGAgb24gYQpub24tcG9vbGVkIGVzY3Jvdy4AAAAQZ2V0X2NvbnRyaWJ1dGlvbgAAAAIAAAAAAAAACWVzY3Jvd19pZAAAAAAAAAYAAAAAAAAAC2NvbnRyaWJ1dG9yAAAAABMAAAABAAAD6QAAA+gAAAfQAAAADENvbnRyaWJ1dGlvbgAAAAM=",
        "AAAAAAAAA1VDcmVhdGVzIGEgcG9vbGVkIGVzY3JvdyBmdW5kZWQgYnkgbWFueSBwYXllcnMgKGlzc3VlICMxMTMsCmRvY3MvYWRyLzAwMTEpLiBgY3JlYXRvcmAgc2V0cyB0aGUgZGVhbCDigJQgcGF5ZWUsIHRva2VuLCByZWxlYXNlciwKb3BhcXVlIGBjb25kaXRpb25fcmVmYCwgYW4gZXhwbGljaXQgYGZ1bmRpbmdfdGFyZ2V0YCAoPiAwKSBhbmQgYQpgZnVuZGluZ19kZWFkbGluZWAgKHVuaXggc2Vjb25kcywgc3RyaWN0bHkgaW4gdGhlIGZ1dHVyZSkg4oCUIGJ1dApmdW5kcyBub3RoaW5nIGF0IGNyZWF0aW9uOiBgRXNjcm93RGF0YS5hbW91bnRgIHN0YXJ0cyBhdCAwIGFuZCBncm93cwphcyBjb250cmlidXRvcnMgY2FsbCBgY29udHJpYnV0ZWAuIFJlbGVhc2UgYmVjb21lcyBwb3NzaWJsZSBvbmx5Cm9uY2UgY29udHJpYnV0aW9ucyByZWFjaCB0aGUgdGFyZ2V0IGV4YWN0bHk7IGlmIHRoZSBkZWFkbGluZSBwYXNzZXMKZmlyc3QsIHRoZSByb3VuZCBoYXMgZmFpbGVkIGFuZCBldmVyeSBjb250cmlidXRvciBwdWxscyB0aGVpciBvd24KcmVjb3JkZWQgYW1vdW50IGJhY2sgd2l0aCBgY2xhaW1fcmVmdW5kYC4gYGNyZWF0b3JgIGlzIHN0b3JlZCBhcwp0aGUgZXNjcm93J3MgYHBheWVyYCAoY28tYXV0aG9yaXphdGlvbiBmb3IgYHJvdGF0ZV9yZWxlYXNlcmAgb25seSkKYW5kIGFzIHRoZSBgcmVmdW5kX3RvYCBwbGFjZWhvbGRlcjsgbm8gcHVzaCByZWZ1bmQgcGF0aCBleGlzdHMgZm9yCnBvb2xlZCBlc2Nyb3dzLiBObyBgcmVmdW5kX2FmdGVyYCwgbm8gYWNjZXB0YW5jZSBnYXRlLCBubyBjYWxsYmFjazoKcG9vbGVkIHNldHRsZW1lbnQgcmV1c2VzIHRoZSBwbGFpbiByZWxlYXNlci90aHJlc2hvbGQgcnVsZXMuAAAAAAAAFGNyZWF0ZV9wb29sZWRfZXNjcm93AAAABwAAAAAAAAAHY3JlYXRvcgAAAAATAAAAAAAAAAVwYXllZQAAAAAAABMAAAAAAAAABXRva2VuAAAAAAAAEwAAAAAAAAAOZnVuZGluZ190YXJnZXQAAAAAAAsAAAAAAAAADWNvbmRpdGlvbl9yZWYAAAAAAAAQAAAAAAAAAAhyZWxlYXNlcgAAABMAAAAAAAAAEGZ1bmRpbmdfZGVhZGxpbmUAAAAGAAAAAQAAA+kAAAAGAAAAAw==",
        "AAAAAAAAASdSZXR1cm5zIHRoZSBlc2Nyb3dlZCBgYW1vdW50YCB0byBgcmVmdW5kX3RvYCBvbiBiZWhhbGYgb2YgYW4gTS1vZi1OCnJlbGVhc2VyIHNldCAoZG9jcy9hZHIvMDAwNykuIFNhbWUgYXBwcm92YWwgcnVsZXMgYXMKYHJlbGVhc2Vfd2l0aF9hcHByb3ZhbHNgLiBUaGUgdGltZW91dCByZWZ1bmQgcGF0aCBpbiBgcmVmdW5kYCBzdGF5cwphdmFpbGFibGUgYXMgd2VsbDogb25jZSBgcmVmdW5kX2FmdGVyYCBwYXNzZXMsIGFueW9uZSBjYW4gcmV0dXJuIHRoZQpmdW5kcyB0byB0aGUgcGF5ZXIgd2l0aG91dCBhcHByb3ZhbHMuAAAAABVyZWZ1bmRfd2l0aF9hcHByb3ZhbHMAAAAAAAACAAAAAAAAAAllc2Nyb3dfaWQAAAAAAAAGAAAAAAAAAAlhcHByb3ZlcnMAAAAAAAPqAAAAEwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAZFNb3ZlcyB0aGUgZXNjcm93ZWQgYGFtb3VudGAgdG8gYHBheWVlYCBvbiBiZWhhbGYgb2YgYW4gTS1vZi1OCnJlbGVhc2VyIHNldCAoZG9jcy9hZHIvMDAwNykuIEV2ZXJ5IGFkZHJlc3MgaW4gYGFwcHJvdmVyc2AgbXVzdCBiZSBhCnJlbGVhc2VyLCBhcHBlYXIgYXQgbW9zdCBvbmNlLCBhbmQgYXV0aG9yaXplIHRoaXMgZXhhY3QgaW52b2NhdGlvbjsKYXQgbGVhc3QgYHRocmVzaG9sZGAgZGlzdGluY3QgYXBwcm92ZXJzIGFyZSByZXF1aXJlZC4gQXBwcm92YWxzIGFyZQpub3Qgc3RvcmVkIGJldHdlZW4gY2FsbHMsIHNvIHRoZXJlIGlzIG5vdGhpbmcgdG8gY2xlYXIgb24gc2V0dGxlbWVudAphbmQgbm8gYXBwcm92YWwgdG8gcmVwbGF5IOKAlCBhIHNldHRsZWQgZXNjcm93IGZhaWxzIGBOb3RGdW5kZWRgLgAAAAAAABZyZWxlYXNlX3dpdGhfYXBwcm92YWxzAAAAAAACAAAAAAAAAAllc2Nyb3dfaWQAAAAAAAAGAAAAAAAAAAlhcHByb3ZlcnMAAAAAAAPqAAAAEwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAHhDcmVhdGVzIGEgc2luZ2xlLXJlbGVhc2VyIGVzY3JvdyB3aXRoIGFuIG9wdGlvbmFsIGVhcmxpZXN0IHJlbGVhc2UgdGltZS4KUmVsZWFzZSBpcyBhbGxvd2VkIGF0IHRoZSBjb25maWd1cmVkIHRpbWVzdGFtcC4AAAAaY3JlYXRlX2VzY3Jvd19yZWxlYXNlX3RpbWUAAAAAAAoAAAAAAAAABXBheWVyAAAAAAAAEwAAAAAAAAAFcGF5ZWUAAAAAAAATAAAAAAAAAAV0b2tlbgAAAAAAABMAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAANY29uZGl0aW9uX3JlZgAAAAAAABAAAAAAAAAACHJlbGVhc2VyAAAAEwAAAAAAAAAMcmVmdW5kX2FmdGVyAAAD6AAAAAYAAAAAAAAADG5vdGlmeV9wYXllZQAAAAEAAAAAAAAACXJlZnVuZF90bwAAAAAAA+gAAAATAAAAAAAAABJyZWxlYXNlX25vdF9iZWZvcmUAAAAAA+gAAAAGAAAAAQAAA+kAAAAGAAAAAw==",
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
        contribute: this.txFromJSON<Result<void>>,
        get_escrow: this.txFromJSON<Result<EscrowData>>,
        get_pooled: this.txFromJSON<Result<PooledData>>,
        get_status: this.txFromJSON<Result<EscrowStatus>>,
        settle_many: this.txFromJSON<Result<Array<Result<void>>>>,
        claim_refund: this.txFromJSON<Result<void>>,
        create_escrow: this.txFromJSON<Result<u64>>,
        create_escrows: this.txFromJSON<Result<Array<u64>>>,
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