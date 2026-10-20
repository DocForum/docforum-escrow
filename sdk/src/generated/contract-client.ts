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
   * A settlement (`resolve_dispute`/`settle`) was attempted on an escrow
   * that is not currently `Disputed`.
   */
  21: {message:"NotDisputed"},
  /**
   * The basis points are out of range or don't sum to 10_000.
   */
  22: {message:"InvalidSplit"},
  /**
   * `resolve_dispute` was called on a dispute that already has a recorded
   * split. One resolution per dispute keeps the payout deterministic.
   */
  23: {message:"AlreadyResolved"},
  /**
   * `settle` was called before the arbiter recorded a split.
   */
  24: {message:"NotResolved"}
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
  payer: string;
  /**
 * Optional deadline (unix seconds) after which `refund` opens to
 * anyone — still only back to `payer`. `None` means no timeout,
 * behaviour identical to before this field existed — see docs/adr/0004.
 */
refund_after: Option<u64>;
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
 * Per-escrow dispute state — deliberately a separate storage entry from
 * `EscrowData` so adding disputes did not rewrite the encoding of every
 * escrow created by earlier phases.
 */
export interface DisputeState {
  /**
 * The only address permitted to record a resolution. `None` for escrows
 * created through the pre-E6 entry points; those can never be resolved.
 */
arbiter: Option<string>;
  /**
 * Share of `amount` paid to `payee`, in basis points.
 */
payee_bps: u32;
  /**
 * Share of `amount` returned to `payer`, in basis points.
 */
payer_bps: u32;
  /**
 * Whether `resolve_dispute` has recorded a split. The split fields below
 * are meaningful only when this is true.
 * 
 * A flat flag plus two `u32`s rather than `Option<SplitBps>`: an
 * `Option<contracttype struct>` field is not round-trippable by the SDK
 * 27 derive under `testutils`, so it would not compile for the tests.
 */
resolved: boolean;
}

export type EscrowStatus = {tag: "Funded", values: void} | {tag: "Released", values: void} | {tag: "Refunded", values: void} | {tag: "Disputed", values: void};

export interface Client {
  /**
   * Construct and simulate a accept transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Records the payee's acceptance for an opted-in funded escrow.
   */
  accept: ({escrow_id, payee}: {escrow_id: u64, payee: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a refund transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the escrowed `amount` to `payer`. Same state rule as
   * `release` (only while `Funded`), but two callers are authorised:
   * 
   * - the escrow's releaser (docs/adr/0002), always; or
   * - **anyone**, once `refund_after` has been reached — the timeout
   * refund path for a lost/unsignable releaser key (docs/adr/0004).
   * 
   * The destination never changes: timeout or not, funds only ever go
   * back to the stored `payer`. With no `refund_after` set, behaviour
   * is identical to before the timeout existed — releaser only. On an
   * M-of-N escrow the releaser path needs a threshold of 1; otherwise use
   * `refund_with_approvals` (the timeout path stays open to anyone).
   */
  refund: ({escrow_id, caller}: {escrow_id: u64, caller: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a settle transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Pays both sides of a `Disputed` escrow according to the split the
   * arbiter recorded with `resolve_dispute` (Phase E6, docs/adr/0009).
   * 
   * Deliberately permissionless: the split is already fixed and was
   * authorised by the arbiter, so settling it is a deterministic transfer
   * that cannot be redirected. Letting anyone submit it means a
   * disappeared arbiter (or a payer/payee who stops paying fees) cannot
   * strand the funds. Fails `NotResolved` before a split exists and
   * `NotDisputed` on a settled or non-disputed escrow.
   * 
   * The escrow is marked `Released` before the transfers
   * (checks-effects-interactions, docs/adr/0006) and a failing transfer
   * rolls the whole invocation back. The payee acceptance gate is not
   * applied here: an arbiter's resolution is the authorisation.
   */
  settle: ({escrow_id}: {escrow_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

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
   * Construct and simulate a get_escrow transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Read-only accessor for everything stored about `escrow_id` — payer,
   * payee, token, amount, `condition_ref`, status, the releaser set with
   * its threshold, and `refund_after`. Exists so payees and integrators
   * can check who can settle and when before relying on a `Funded`
   * escrow (docs/adr/0004, threat model T8). Errors on an unknown id.
   */
  get_escrow: ({escrow_id}: {escrow_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<EscrowData>>>

  /**
   * Construct and simulate a get_status transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Read-only status query. Errors if `escrow_id` doesn't exist.
   */
  get_status: ({escrow_id}: {escrow_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<EscrowStatus>>>

  /**
   * Construct and simulate a get_dispute transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Read-only: the escrow's arbiter and recorded split, if any. Errors if
   * `escrow_id` doesn't exist. Escrows created before Phase E6 (and those
   * created without `create_escrow_with_arbiter`) report `arbiter: None`
   * and can never be resolved.
   */
  get_dispute: ({escrow_id}: {escrow_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<DisputeState>>>

  /**
   * Construct and simulate a create_escrow transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Locks `amount` of `token` pulled from `payer`, held for `payee`,
   * docs/threat-model.md T10 and ROADMAP.md Phase E5). `releaser` is the
   * address permitted to call `release`/`refund` on this escrow
   * (docs/adr/0002). `refund_after` is optional (docs/adr/0004).
   * `notify_payee` opts an implementing contract payee into
   * `on_escrow_released(escrow_id, amount)` (docs/adr/0005). The payer
   * must authorize creation, and the payee must also authorize if
   * `notify_payee` is true. For M-of-N releasers use
   * `create_escrow_with_releasers`.
   */
  create_escrow: ({payer, payee, token, amount, condition_ref, releaser, refund_after, notify_payee}: {payer: string, payee: string, token: string, amount: i128, condition_ref: string, releaser: string, refund_after: Option<u64>, notify_payee: boolean}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a raise_dispute transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Opens a dispute on a `Funded` escrow (Phase E6, docs/adr/0009).
   * 
   * `payer`, `payee` and any address in the escrow's releaser set may call
   * this — everyone with a stake in the outcome. The escrow moves to
   * `Disputed`, which rejects `release`/`refund` (and the approval
   * variants) until the arbiter's split is settled, so the funds cannot
   * move out from under an in-flight adjudication.
   * 
   * Raising a dispute never transfers anything, so it is safe to allow
   * every party to trigger it; the arbiter, not the caller, decides the
   * outcome.
   */
  raise_dispute: ({escrow_id, caller}: {escrow_id: u64, caller: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a resolve_dispute transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Records the arbiter's resolution for a `Disputed` escrow as basis
   * points of the escrowed `amount`: `payer_bps` back to `payer`,
   * `payee_bps` to `payee` (Phase E6, docs/adr/0009).
   * 
   * Only the escrow's stored arbiter may call this, only while the escrow
   * is `Disputed`, and only once — a recorded split is final, so a second
   * call fails `AlreadyResolved` instead of silently rewriting the payout.
   * `payer_bps + payee_bps` must equal 10_000 (100%); a `0`/`10_000` split
   * is a full refund/release and is allowed.
   * 
   * This call only records the split; `settle` is what moves the funds, so
   * a resolver can be inspected before it pays out.
   */
  resolve_dispute: ({escrow_id, caller, payer_bps, payee_bps}: {escrow_id: u64, caller: string, payer_bps: u32, payee_bps: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a refund_with_approvals transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the escrowed `amount` to `payer` on behalf of an M-of-N
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
   * Construct and simulate a create_escrow_with_arbiter transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Same as `create_escrow`, but also records the only address allowed to
   * adjudicate a dispute over this escrow (Phase E6, docs/adr/0009).
   * Omitting this entry point (i.e. using `create_escrow`) keeps the
   * pre-E6 behaviour: nobody can resolve a dispute on that escrow.
   */
  create_escrow_with_arbiter: ({payer, payee, token, amount, condition_ref, releaser, refund_after, arbiter, notify_payee}: {payer: string, payee: string, token: string, amount: i128, condition_ref: string, releaser: string, refund_after: Option<u64>, arbiter: string, notify_payee: boolean}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

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
  create_escrow_with_releasers: ({payer, payee, token, amount, condition_ref, releasers, threshold, refund_after, notify_payee}: {payer: string, payee: string, token: string, amount: i128, condition_ref: string, releasers: Array<string>, threshold: u32, refund_after: Option<u64>, notify_payee: boolean}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a create_escrow_with_acceptance transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Creates an escrow with an opt-in payee acceptance gate. Existing
   * integrations can keep using `create_escrow`, which defaults this off.
   */
  create_escrow_with_acceptance: ({payer, payee, token, amount, condition_ref, releaser, refund_after, requires_acceptance}: {payer: string, payee: string, token: string, amount: i128, condition_ref: string, releaser: string, refund_after: Option<u64>, requires_acceptance: boolean}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

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
      new ContractSpec([ "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAAFgAAAAAAAAAITm90Rm91bmQAAAABAAAAAAAAAA1JbnZhbGlkQW1vdW50AAAAAAAAAgAAAAAAAAAMVW5hdXRob3JpemVkAAAAAwAAAAAAAAAJTm90RnVuZGVkAAAAAAAABAAAALpgcmVmdW5kX2FmdGVyYCB3YXMgbm90IHN0cmljdGx5IGluIHRoZSBmdXR1cmUgYXQgY3JlYXRpb24g4oCUIHNlZQpkb2NzL2Fkci8wMDA0OiBhIGRlYWRsaW5lIHRoYXQgaGFzIGFscmVhZHkgcGFzc2VkIHdvdWxkIGxldAphbnlvbmUgcmVmdW5kIHRoZSBlc2Nyb3cgYmVmb3JlIHRoZSByZWxlYXNlciBjb3VsZCBldmVyIGFjdC4AAAAAABJJbnZhbGlkUmVmdW5kQWZ0ZXIAAAAAAAUAAACjVGhlIGNvbnRyYWN0J3MgdG9rZW4gYmFsYW5jZSBkaWRuJ3QgcmlzZSBieSBleGFjdGx5IGBhbW91bnRgCmFjcm9zcyBgY3JlYXRlX2VzY3Jvd2AncyB0cmFuc2ZlciAoYSBseWluZyBvciBzaG9ydC1kZWxpdmVyaW5nCnRva2VuKSDigJQgc2VlIGRvY3MvdGhyZWF0LW1vZGVsLm1kIFQ1LgAAAAAPQmFsYW5jZU1pc21hdGNoAAAAAAYAAAEAYGNvbmRpdGlvbl9yZWZgIGV4Y2VlZGVkIHRoZSBtYXhpbXVtIGFsbG93ZWQgbGVuZ3RoIChjdXJyZW50bHkKNjQgYnl0ZXMpIOKAlCBzZWUgZG9jcy90aHJlYXQtbW9kZWwubWQgVDEwIGFuZCBST0FETUFQLm1kIFBoYXNlIEU1LgpCb3VuZGVkIHRvIGtlZXAgc3RvcmFnZSBhbmQgZXZlbnQgY29zdHMgcHJlZGljdGFibGU7IHJlamVjdCBhdApjcmVhdGlvbiBzbyBubyBvbi1jaGFpbiBzdG9yYWdlIGlzIHdhc3RlZCBvbiBhbiBvdmVyc2l6ZWQgcmVmLgAAABNDb25kaXRpb25SZWZUb29Mb25nAAAAAAcAAAA2YHRva2VuYCBpcyBub3QgaW4gdGhlIGltbXV0YWJsZSBkZXBsb3ktdGltZSBhbGxvd2xpc3QuAAAAAAAPRGlzYWxsb3dlZFRva2VuAAAAAAgAAACDVGhlIG9wdGVkLWluIHBheWVlIGNhbGxiYWNrIHJldHVybmVkIGFuIGVycm9yIG9yIGNvdWxkIG5vdCBiZQppbnZva2VkLiBUaGUgcmVsZWFzZSB0cmFuc2FjdGlvbiAoaW5jbHVkaW5nIGl0cyB0cmFuc2Zlcikgcm9sbHMgYmFjay4AAAAADkNhbGxiYWNrRmFpbGVkAAAAAAAJAAAAAAAAAAhPdmVyZmxvdwAAAAwAAABsVGhlIHJlbGVhc2VyIHNldCBpcyBlbXB0eSwgb3IgYHRocmVzaG9sZGAgaXMgMCBvciBsYXJnZXIgdGhhbiB0aGUKbnVtYmVyIG9mIHJlbGVhc2VycyDigJQgc2VlIGRvY3MvYWRyLzAwMDcuAAAAEEludmFsaWRUaHJlc2hvbGQAAAANAAAAQ01vcmUgdGhhbiBgTUFYX1JFTEVBU0VSU2AgKDEwKSBhZGRyZXNzZXMgd2VyZSBzdXBwbGllZCBhdCBjcmVhdGlvbi4AAAAAEFRvb01hbnlSZWxlYXNlcnMAAAAOAAAAn0Zld2VyIGRpc3RpbmN0IGFwcHJvdmFscyB3ZXJlIHN1cHBsaWVkIHRoYW4gdGhlIGVzY3JvdydzIHRocmVzaG9sZCwKb3IgYSBzaW5nbGUgcmVsZWFzZXIgdHJpZWQgdG8gc2V0dGxlIGEgcXVvcnVtIGVzY3JvdyB0aHJvdWdoIHRoZQpzaW5nbGUtY2FsbGVyIGVudHJ5IHBvaW50LgAAAAAPVGhyZXNob2xkTm90TWV0AAAAAA8AAABoVGhlIHNhbWUgYWRkcmVzcyBhcHBlYXJlZCB0d2ljZSBpbiBvbmUgYXBwcm92YWwgbGlzdC4gRHVwbGljYXRlcwpuZXZlciBjb3VudCB0d2ljZSB0b3dhcmQgdGhlIHRocmVzaG9sZC4AAAARRHVwbGljYXRlQXBwcm92ZXIAAAAAAAAQAAAAQFRoZSBzYW1lIGFkZHJlc3MgYXBwZWFyZWQgdHdpY2UgaW4gdGhlIHJlbGVhc2VyIHNldCBhdCBjcmVhdGlvbi4AAAARRHVwbGljYXRlUmVsZWFzZXIAAAAAAAARAAAAAAAAABJBY2NlcHRhbmNlUmVxdWlyZWQAAAAAABIAAAAAAAAAF0FjY2VwdGFuY2VOb3RDb25maWd1cmVkAAAAABMAAAAAAAAAD0FscmVhZHlBY2NlcHRlZAAAAAAUAAAAZkEgc2V0dGxlbWVudCAoYHJlc29sdmVfZGlzcHV0ZWAvYHNldHRsZWApIHdhcyBhdHRlbXB0ZWQgb24gYW4gZXNjcm93CnRoYXQgaXMgbm90IGN1cnJlbnRseSBgRGlzcHV0ZWRgLgAAAAAAC05vdERpc3B1dGVkAAAAABUAAAA5VGhlIGJhc2lzIHBvaW50cyBhcmUgb3V0IG9mIHJhbmdlIG9yIGRvbid0IHN1bSB0byAxMF8wMDAuAAAAAAAADEludmFsaWRTcGxpdAAAABYAAACHYHJlc29sdmVfZGlzcHV0ZWAgd2FzIGNhbGxlZCBvbiBhIGRpc3B1dGUgdGhhdCBhbHJlYWR5IGhhcyBhIHJlY29yZGVkCnNwbGl0LiBPbmUgcmVzb2x1dGlvbiBwZXIgZGlzcHV0ZSBrZWVwcyB0aGUgcGF5b3V0IGRldGVybWluaXN0aWMuAAAAAA9BbHJlYWR5UmVzb2x2ZWQAAAAAFwAAADhgc2V0dGxlYCB3YXMgY2FsbGVkIGJlZm9yZSB0aGUgYXJiaXRlciByZWNvcmRlZCBhIHNwbGl0LgAAAAtOb3RSZXNvbHZlZAAAAAAY",
        "AAAAAQAAAAAAAAAAAAAACkVzY3Jvd0RhdGEAAAAAAAwAAAA1TGVkZ2VyIHRpbWVzdGFtcCBhdCB3aGljaCB0aGUgcGF5ZWUgYWNjZXB0ZWQsIGlmIGFueS4AAAAAAAALYWNjZXB0ZWRfYXQAAAAD6AAAAAYAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAANY29uZGl0aW9uX3JlZgAAAAAAABAAAACGSWYgdHJ1ZSwgaW52b2tlIHRoZSBjb250cmFjdCBwYXllZSdzIGBvbl9lc2Nyb3dfcmVsZWFzZWRgIGhvb2sgYWZ0ZXIKdGhlIHBheW91dCB0cmFuc2Zlci4gQSBmYWlsZWQgY2FsbGJhY2sgcmV2ZXJ0cyB0aGUgd2hvbGUgcmVsZWFzZS4AAAAAAAxub3RpZnlfcGF5ZWUAAAABAAAAAAAAAAVwYXllZQAAAAAAABMAAAAAAAAABXBheWVyAAAAAAAAEwAAAMZPcHRpb25hbCBkZWFkbGluZSAodW5peCBzZWNvbmRzKSBhZnRlciB3aGljaCBgcmVmdW5kYCBvcGVucyB0bwphbnlvbmUg4oCUIHN0aWxsIG9ubHkgYmFjayB0byBgcGF5ZXJgLiBgTm9uZWAgbWVhbnMgbm8gdGltZW91dCwKYmVoYXZpb3VyIGlkZW50aWNhbCB0byBiZWZvcmUgdGhpcyBmaWVsZCBleGlzdGVkIOKAlCBzZWUgZG9jcy9hZHIvMDAwNC4AAAAAAAxyZWZ1bmRfYWZ0ZXIAAAPoAAAABgAAAL1BZGRyZXNzZXMgcGVybWl0dGVkIHRvIHNldHRsZSB0aGlzIGVzY3JvdyDigJQgc2VlIGRvY3MvYWRyLzAwMDIgZm9yIHRoZQpwZXItZXNjcm93IHJlbGVhc2VyLCBhbmQgZG9jcy9hZHIvMDAwNyBmb3IgTS1vZi1OIHNldHMuIEEgcGxhaW4Kc2luZ2xlLXJlbGVhc2VyIGVzY3JvdyBzdG9yZXMgZXhhY3RseSBvbmUgZW50cnkgaGVyZS4AAAAAAAAJcmVsZWFzZXJzAAAAAAAD6gAAABMAAAA5V2hldGhlciByZWxlYXNlIHJlcXVpcmVzIHRoZSBwYXllZSdzIGV4cGxpY2l0IGFjY2VwdGFuY2UuAAAAAAAAE3JlcXVpcmVzX2FjY2VwdGFuY2UAAAAAAQAAAAAAAAAGc3RhdHVzAAAAAAfQAAAADEVzY3Jvd1N0YXR1cwAAALpIb3cgbWFueSAqZGlzdGluY3QqIGFkZHJlc3NlcyBmcm9tIGByZWxlYXNlcnNgIG11c3QgYXV0aG9yaXplIG9uZQpzZXR0bGVtZW50LiBBbHdheXMgYD49IDFgIGFuZCBgPD0gcmVsZWFzZXJzLmxlbigpYDsgYDFgIG1lYW5zIGFueQpzaW5nbGUgcmVsZWFzZXIgY2FuIHNldHRsZSAodGhlIHByZS1xdW9ydW0gYmVoYXZpb3VyKS4AAAAAAAl0aHJlc2hvbGQAAAAAAAAEAAAAAAAAAAV0b2tlbgAAAAAAABM=",
        "AAAAAQAAAK9QZXItZXNjcm93IGRpc3B1dGUgc3RhdGUg4oCUIGRlbGliZXJhdGVseSBhIHNlcGFyYXRlIHN0b3JhZ2UgZW50cnkgZnJvbQpgRXNjcm93RGF0YWAgc28gYWRkaW5nIGRpc3B1dGVzIGRpZCBub3QgcmV3cml0ZSB0aGUgZW5jb2Rpbmcgb2YgZXZlcnkKZXNjcm93IGNyZWF0ZWQgYnkgZWFybGllciBwaGFzZXMuAAAAAAAAAAAMRGlzcHV0ZVN0YXRlAAAABAAAAItUaGUgb25seSBhZGRyZXNzIHBlcm1pdHRlZCB0byByZWNvcmQgYSByZXNvbHV0aW9uLiBgTm9uZWAgZm9yIGVzY3Jvd3MKY3JlYXRlZCB0aHJvdWdoIHRoZSBwcmUtRTYgZW50cnkgcG9pbnRzOyB0aG9zZSBjYW4gbmV2ZXIgYmUgcmVzb2x2ZWQuAAAAAAdhcmJpdGVyAAAAA+gAAAATAAAAM1NoYXJlIG9mIGBhbW91bnRgIHBhaWQgdG8gYHBheWVlYCwgaW4gYmFzaXMgcG9pbnRzLgAAAAAJcGF5ZWVfYnBzAAAAAAAABAAAADdTaGFyZSBvZiBgYW1vdW50YCByZXR1cm5lZCB0byBgcGF5ZXJgLCBpbiBiYXNpcyBwb2ludHMuAAAAAAlwYXllcl9icHMAAAAAAAAEAAABN1doZXRoZXIgYHJlc29sdmVfZGlzcHV0ZWAgaGFzIHJlY29yZGVkIGEgc3BsaXQuIFRoZSBzcGxpdCBmaWVsZHMgYmVsb3cKYXJlIG1lYW5pbmdmdWwgb25seSB3aGVuIHRoaXMgaXMgdHJ1ZS4KCkEgZmxhdCBmbGFnIHBsdXMgdHdvIGB1MzJgcyByYXRoZXIgdGhhbiBgT3B0aW9uPFNwbGl0QnBzPmA6IGFuCmBPcHRpb248Y29udHJhY3R0eXBlIHN0cnVjdD5gIGZpZWxkIGlzIG5vdCByb3VuZC10cmlwcGFibGUgYnkgdGhlIFNESwoyNyBkZXJpdmUgdW5kZXIgYHRlc3R1dGlsc2AsIHNvIGl0IHdvdWxkIG5vdCBjb21waWxlIGZvciB0aGUgdGVzdHMuAAAAAAhyZXNvbHZlZAAAAAE=",
        "AAAAAgAAAAAAAAAAAAAADEVzY3Jvd1N0YXR1cwAAAAQAAAAAAAAAAAAAAAZGdW5kZWQAAAAAAAAAAAAAAAAACFJlbGVhc2VkAAAAAAAAAAAAAAAIUmVmdW5kZWQAAAAAAAAArkEgYEZ1bmRlZGAgZXNjcm93IHdob3NlIHBhcnRpZXMgYXNrZWQgdGhlIGFyYml0ZXIgdG8gYWRqdWRpY2F0ZSBpdC4KYHJlbGVhc2VgL2ByZWZ1bmRgIGFyZSByZWplY3RlZCB1bnRpbCB0aGUgYXJiaXRlciByZWNvcmRzIGEgc3BsaXQgYW5kCml0IGlzIHNldHRsZWQg4oCUIHNlZSBkb2NzL2Fkci8wMDA5LgAAAAAACERpc3B1dGVk",
        "AAAAAAAAAD1SZWNvcmRzIHRoZSBwYXllZSdzIGFjY2VwdGFuY2UgZm9yIGFuIG9wdGVkLWluIGZ1bmRlZCBlc2Nyb3cuAAAAAAAABmFjY2VwdAAAAAAAAgAAAAAAAAAJZXNjcm93X2lkAAAAAAAABgAAAAAAAAAFcGF5ZWUAAAAAAAATAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAoVSZXR1cm5zIHRoZSBlc2Nyb3dlZCBgYW1vdW50YCB0byBgcGF5ZXJgLiBTYW1lIHN0YXRlIHJ1bGUgYXMKYHJlbGVhc2VgIChvbmx5IHdoaWxlIGBGdW5kZWRgKSwgYnV0IHR3byBjYWxsZXJzIGFyZSBhdXRob3Jpc2VkOgoKLSB0aGUgZXNjcm93J3MgcmVsZWFzZXIgKGRvY3MvYWRyLzAwMDIpLCBhbHdheXM7IG9yCi0gKiphbnlvbmUqKiwgb25jZSBgcmVmdW5kX2FmdGVyYCBoYXMgYmVlbiByZWFjaGVkIOKAlCB0aGUgdGltZW91dApyZWZ1bmQgcGF0aCBmb3IgYSBsb3N0L3Vuc2lnbmFibGUgcmVsZWFzZXIga2V5IChkb2NzL2Fkci8wMDA0KS4KClRoZSBkZXN0aW5hdGlvbiBuZXZlciBjaGFuZ2VzOiB0aW1lb3V0IG9yIG5vdCwgZnVuZHMgb25seSBldmVyIGdvCmJhY2sgdG8gdGhlIHN0b3JlZCBgcGF5ZXJgLiBXaXRoIG5vIGByZWZ1bmRfYWZ0ZXJgIHNldCwgYmVoYXZpb3VyCmlzIGlkZW50aWNhbCB0byBiZWZvcmUgdGhlIHRpbWVvdXQgZXhpc3RlZCDigJQgcmVsZWFzZXIgb25seS4gT24gYW4KTS1vZi1OIGVzY3JvdyB0aGUgcmVsZWFzZXIgcGF0aCBuZWVkcyBhIHRocmVzaG9sZCBvZiAxOyBvdGhlcndpc2UgdXNlCmByZWZ1bmRfd2l0aF9hcHByb3ZhbHNgICh0aGUgdGltZW91dCBwYXRoIHN0YXlzIG9wZW4gdG8gYW55b25lKS4AAAAAAAAGcmVmdW5kAAAAAAACAAAAAAAAAAllc2Nyb3dfaWQAAAAAAAAGAAAAAAAAAAZjYWxsZXIAAAAAABMAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAvZQYXlzIGJvdGggc2lkZXMgb2YgYSBgRGlzcHV0ZWRgIGVzY3JvdyBhY2NvcmRpbmcgdG8gdGhlIHNwbGl0IHRoZQphcmJpdGVyIHJlY29yZGVkIHdpdGggYHJlc29sdmVfZGlzcHV0ZWAgKFBoYXNlIEU2LCBkb2NzL2Fkci8wMDA5KS4KCkRlbGliZXJhdGVseSBwZXJtaXNzaW9ubGVzczogdGhlIHNwbGl0IGlzIGFscmVhZHkgZml4ZWQgYW5kIHdhcwphdXRob3Jpc2VkIGJ5IHRoZSBhcmJpdGVyLCBzbyBzZXR0bGluZyBpdCBpcyBhIGRldGVybWluaXN0aWMgdHJhbnNmZXIKdGhhdCBjYW5ub3QgYmUgcmVkaXJlY3RlZC4gTGV0dGluZyBhbnlvbmUgc3VibWl0IGl0IG1lYW5zIGEKZGlzYXBwZWFyZWQgYXJiaXRlciAob3IgYSBwYXllci9wYXllZSB3aG8gc3RvcHMgcGF5aW5nIGZlZXMpIGNhbm5vdApzdHJhbmQgdGhlIGZ1bmRzLiBGYWlscyBgTm90UmVzb2x2ZWRgIGJlZm9yZSBhIHNwbGl0IGV4aXN0cyBhbmQKYE5vdERpc3B1dGVkYCBvbiBhIHNldHRsZWQgb3Igbm9uLWRpc3B1dGVkIGVzY3Jvdy4KClRoZSBlc2Nyb3cgaXMgbWFya2VkIGBSZWxlYXNlZGAgYmVmb3JlIHRoZSB0cmFuc2ZlcnMKKGNoZWNrcy1lZmZlY3RzLWludGVyYWN0aW9ucywgZG9jcy9hZHIvMDAwNikgYW5kIGEgZmFpbGluZyB0cmFuc2Zlcgpyb2xscyB0aGUgd2hvbGUgaW52b2NhdGlvbiBiYWNrLiBUaGUgcGF5ZWUgYWNjZXB0YW5jZSBnYXRlIGlzIG5vdAphcHBsaWVkIGhlcmU6IGFuIGFyYml0ZXIncyByZXNvbHV0aW9uIGlzIHRoZSBhdXRob3Jpc2F0aW9uLgAAAAAABnNldHRsZQAAAAAAAQAAAAAAAAAJZXNjcm93X2lkAAAAAAAABgAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAHVBZGRzIGZ1bmRzIHRvIGEgZnVuZGVkIGVzY3JvdyB3aXRob3V0IGNoYW5naW5nIGl0cyBwYXJ0aWVzIG9yIGlkLgpPbmx5IGl0cyBvcmlnaW5hbCBwYXllciBtYXkgYXV0aG9yaXplIHRoZSB0cmFuc2Zlci4AAAAAAAAGdG9wX3VwAAAAAAADAAAAAAAAAAllc2Nyb3dfaWQAAAAAAAAGAAAAAAAAAAVwYXllcgAAAAAAABMAAAAAAAAABmFtb3VudAAAAAAACwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAcxNb3ZlcyB0aGUgZXNjcm93ZWQgYGFtb3VudGAgdG8gYHBheWVlYC4gT25seSB0aGUgZXNjcm93J3MgcmVsZWFzZXIKbWF5IGNhbGwgdGhpcyDigJQgdGhlIGNvbnRyYWN0IGVuZm9yY2VzIFdITywgbmV2ZXIgV0hZIChBRFIgMDAwMSkuIE9uCmFuIE0tb2YtTiBlc2Nyb3cgdGhpcyBzaW5nbGUtY2FsbGVyIHBhdGggaXMgb25seSBhbGxvd2VkIHdoZW4gdGhlCnRocmVzaG9sZCBpcyAxOyBvdGhlcndpc2UgdXNlIGByZWxlYXNlX3dpdGhfYXBwcm92YWxzYC4KCkRlbGliZXJhdGVseSAqKm5vdCoqIGdhdGVkIGJ5IGByZWZ1bmRfYWZ0ZXJgIChkb2NzL2Fkci8wMDA0KTogYWZ0ZXIKdGhlIGRlYWRsaW5lIHRoZSByZWxlYXNlciBjYW4gc3RpbGwgcmVsZWFzZSwgcmFjaW5nIGFueSB0aW1lb3V0CnJlZnVuZCDigJQgd2hvZXZlciBsYW5kcyBmaXJzdCB3aW5zIGFuZCB0aGUgb3RoZXIgZmFpbHMgYE5vdEZ1bmRlZGAuAAAAB3JlbGVhc2UAAAAAAgAAAAAAAAAJZXNjcm93X2lkAAAAAAAABgAAAAAAAAAGY2FsbGVyAAAAAAATAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAU9SZWFkLW9ubHkgYWNjZXNzb3IgZm9yIGV2ZXJ5dGhpbmcgc3RvcmVkIGFib3V0IGBlc2Nyb3dfaWRgIOKAlCBwYXllciwKcGF5ZWUsIHRva2VuLCBhbW91bnQsIGBjb25kaXRpb25fcmVmYCwgc3RhdHVzLCB0aGUgcmVsZWFzZXIgc2V0IHdpdGgKaXRzIHRocmVzaG9sZCwgYW5kIGByZWZ1bmRfYWZ0ZXJgLiBFeGlzdHMgc28gcGF5ZWVzIGFuZCBpbnRlZ3JhdG9ycwpjYW4gY2hlY2sgd2hvIGNhbiBzZXR0bGUgYW5kIHdoZW4gYmVmb3JlIHJlbHlpbmcgb24gYSBgRnVuZGVkYAplc2Nyb3cgKGRvY3MvYWRyLzAwMDQsIHRocmVhdCBtb2RlbCBUOCkuIEVycm9ycyBvbiBhbiB1bmtub3duIGlkLgAAAAAKZ2V0X2VzY3JvdwAAAAAAAQAAAAAAAAAJZXNjcm93X2lkAAAAAAAABgAAAAEAAAPpAAAH0AAAAApFc2Nyb3dEYXRhAAAAAAAD",
        "AAAAAAAAADxSZWFkLW9ubHkgc3RhdHVzIHF1ZXJ5LiBFcnJvcnMgaWYgYGVzY3Jvd19pZGAgZG9lc24ndCBleGlzdC4AAAAKZ2V0X3N0YXR1cwAAAAAAAQAAAAAAAAAJZXNjcm93X2lkAAAAAAAABgAAAAEAAAPpAAAH0AAAAAxFc2Nyb3dTdGF0dXMAAAAD",
        "AAAAAAAAAOtSZWFkLW9ubHk6IHRoZSBlc2Nyb3cncyBhcmJpdGVyIGFuZCByZWNvcmRlZCBzcGxpdCwgaWYgYW55LiBFcnJvcnMgaWYKYGVzY3Jvd19pZGAgZG9lc24ndCBleGlzdC4gRXNjcm93cyBjcmVhdGVkIGJlZm9yZSBQaGFzZSBFNiAoYW5kIHRob3NlCmNyZWF0ZWQgd2l0aG91dCBgY3JlYXRlX2VzY3Jvd193aXRoX2FyYml0ZXJgKSByZXBvcnQgYGFyYml0ZXI6IE5vbmVgCmFuZCBjYW4gbmV2ZXIgYmUgcmVzb2x2ZWQuAAAAAAtnZXRfZGlzcHV0ZQAAAAABAAAAAAAAAAllc2Nyb3dfaWQAAAAAAAAGAAAAAQAAA+kAAAfQAAAADERpc3B1dGVTdGF0ZQAAAAM=",
        "AAAAAAAAAHtTZXRzIHRoZSBpbW11dGFibGUgdG9rZW4gYWxsb3dsaXN0IGF0IGRlcGxveW1lbnQuIEFuIGVtcHR5IGxpc3QKcHJlc2VydmVzIHRoZSBsZWdhY3kgYmVoYXZpb3IgYW5kIGFsbG93cyBhbnkgdG9rZW4gYWRkcmVzcy4AAAAADV9fY29uc3RydWN0b3IAAAAAAAABAAAAAAAAAA5hbGxvd2VkX3Rva2VucwAAAAAD6gAAABMAAAAA",
        "AAAAAAAAAghMb2NrcyBgYW1vdW50YCBvZiBgdG9rZW5gIHB1bGxlZCBmcm9tIGBwYXllcmAsIGhlbGQgZm9yIGBwYXllZWAsCmRvY3MvdGhyZWF0LW1vZGVsLm1kIFQxMCBhbmQgUk9BRE1BUC5tZCBQaGFzZSBFNSkuIGByZWxlYXNlcmAgaXMgdGhlCmFkZHJlc3MgcGVybWl0dGVkIHRvIGNhbGwgYHJlbGVhc2VgL2ByZWZ1bmRgIG9uIHRoaXMgZXNjcm93Cihkb2NzL2Fkci8wMDAyKS4gYHJlZnVuZF9hZnRlcmAgaXMgb3B0aW9uYWwgKGRvY3MvYWRyLzAwMDQpLgpgbm90aWZ5X3BheWVlYCBvcHRzIGFuIGltcGxlbWVudGluZyBjb250cmFjdCBwYXllZSBpbnRvCmBvbl9lc2Nyb3dfcmVsZWFzZWQoZXNjcm93X2lkLCBhbW91bnQpYCAoZG9jcy9hZHIvMDAwNSkuIFRoZSBwYXllcgptdXN0IGF1dGhvcml6ZSBjcmVhdGlvbiwgYW5kIHRoZSBwYXllZSBtdXN0IGFsc28gYXV0aG9yaXplIGlmCmBub3RpZnlfcGF5ZWVgIGlzIHRydWUuIEZvciBNLW9mLU4gcmVsZWFzZXJzIHVzZQpgY3JlYXRlX2VzY3Jvd193aXRoX3JlbGVhc2Vyc2AuAAAADWNyZWF0ZV9lc2Nyb3cAAAAAAAAIAAAAAAAAAAVwYXllcgAAAAAAABMAAAAAAAAABXBheWVlAAAAAAAAEwAAAAAAAAAFdG9rZW4AAAAAAAATAAAAAAAAAAZhbW91bnQAAAAAAAsAAAAAAAAADWNvbmRpdGlvbl9yZWYAAAAAAAAQAAAAAAAAAAhyZWxlYXNlcgAAABMAAAAAAAAADHJlZnVuZF9hZnRlcgAAA+gAAAAGAAAAAAAAAAxub3RpZnlfcGF5ZWUAAAABAAAAAQAAA+kAAAAGAAAAAw==",
        "AAAAAAAAAg1PcGVucyBhIGRpc3B1dGUgb24gYSBgRnVuZGVkYCBlc2Nyb3cgKFBoYXNlIEU2LCBkb2NzL2Fkci8wMDA5KS4KCmBwYXllcmAsIGBwYXllZWAgYW5kIGFueSBhZGRyZXNzIGluIHRoZSBlc2Nyb3cncyByZWxlYXNlciBzZXQgbWF5IGNhbGwKdGhpcyDigJQgZXZlcnlvbmUgd2l0aCBhIHN0YWtlIGluIHRoZSBvdXRjb21lLiBUaGUgZXNjcm93IG1vdmVzIHRvCmBEaXNwdXRlZGAsIHdoaWNoIHJlamVjdHMgYHJlbGVhc2VgL2ByZWZ1bmRgIChhbmQgdGhlIGFwcHJvdmFsCnZhcmlhbnRzKSB1bnRpbCB0aGUgYXJiaXRlcidzIHNwbGl0IGlzIHNldHRsZWQsIHNvIHRoZSBmdW5kcyBjYW5ub3QKbW92ZSBvdXQgZnJvbSB1bmRlciBhbiBpbi1mbGlnaHQgYWRqdWRpY2F0aW9uLgoKUmFpc2luZyBhIGRpc3B1dGUgbmV2ZXIgdHJhbnNmZXJzIGFueXRoaW5nLCBzbyBpdCBpcyBzYWZlIHRvIGFsbG93CmV2ZXJ5IHBhcnR5IHRvIHRyaWdnZXIgaXQ7IHRoZSBhcmJpdGVyLCBub3QgdGhlIGNhbGxlciwgZGVjaWRlcyB0aGUKb3V0Y29tZS4AAAAAAAANcmFpc2VfZGlzcHV0ZQAAAAAAAAIAAAAAAAAACWVzY3Jvd19pZAAAAAAAAAYAAAAAAAAABmNhbGxlcgAAAAAAEwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAm9SZWNvcmRzIHRoZSBhcmJpdGVyJ3MgcmVzb2x1dGlvbiBmb3IgYSBgRGlzcHV0ZWRgIGVzY3JvdyBhcyBiYXNpcwpwb2ludHMgb2YgdGhlIGVzY3Jvd2VkIGBhbW91bnRgOiBgcGF5ZXJfYnBzYCBiYWNrIHRvIGBwYXllcmAsCmBwYXllZV9icHNgIHRvIGBwYXllZWAgKFBoYXNlIEU2LCBkb2NzL2Fkci8wMDA5KS4KCk9ubHkgdGhlIGVzY3JvdydzIHN0b3JlZCBhcmJpdGVyIG1heSBjYWxsIHRoaXMsIG9ubHkgd2hpbGUgdGhlIGVzY3JvdwppcyBgRGlzcHV0ZWRgLCBhbmQgb25seSBvbmNlIOKAlCBhIHJlY29yZGVkIHNwbGl0IGlzIGZpbmFsLCBzbyBhIHNlY29uZApjYWxsIGZhaWxzIGBBbHJlYWR5UmVzb2x2ZWRgIGluc3RlYWQgb2Ygc2lsZW50bHkgcmV3cml0aW5nIHRoZSBwYXlvdXQuCmBwYXllcl9icHMgKyBwYXllZV9icHNgIG11c3QgZXF1YWwgMTBfMDAwICgxMDAlKTsgYSBgMGAvYDEwXzAwMGAgc3BsaXQKaXMgYSBmdWxsIHJlZnVuZC9yZWxlYXNlIGFuZCBpcyBhbGxvd2VkLgoKVGhpcyBjYWxsIG9ubHkgcmVjb3JkcyB0aGUgc3BsaXQ7IGBzZXR0bGVgIGlzIHdoYXQgbW92ZXMgdGhlIGZ1bmRzLCBzbwphIHJlc29sdmVyIGNhbiBiZSBpbnNwZWN0ZWQgYmVmb3JlIGl0IHBheXMgb3V0LgAAAAAPcmVzb2x2ZV9kaXNwdXRlAAAAAAQAAAAAAAAACWVzY3Jvd19pZAAAAAAAAAYAAAAAAAAABmNhbGxlcgAAAAAAEwAAAAAAAAAJcGF5ZXJfYnBzAAAAAAAABAAAAAAAAAAJcGF5ZWVfYnBzAAAAAAAABAAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAASNSZXR1cm5zIHRoZSBlc2Nyb3dlZCBgYW1vdW50YCB0byBgcGF5ZXJgIG9uIGJlaGFsZiBvZiBhbiBNLW9mLU4KcmVsZWFzZXIgc2V0IChkb2NzL2Fkci8wMDA3KS4gU2FtZSBhcHByb3ZhbCBydWxlcyBhcwpgcmVsZWFzZV93aXRoX2FwcHJvdmFsc2AuIFRoZSB0aW1lb3V0IHJlZnVuZCBwYXRoIGluIGByZWZ1bmRgIHN0YXlzCmF2YWlsYWJsZSBhcyB3ZWxsOiBvbmNlIGByZWZ1bmRfYWZ0ZXJgIHBhc3NlcywgYW55b25lIGNhbiByZXR1cm4gdGhlCmZ1bmRzIHRvIHRoZSBwYXllciB3aXRob3V0IGFwcHJvdmFscy4AAAAAFXJlZnVuZF93aXRoX2FwcHJvdmFscwAAAAAAAAIAAAAAAAAACWVzY3Jvd19pZAAAAAAAAAYAAAAAAAAACWFwcHJvdmVycwAAAAAAA+oAAAATAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAZFNb3ZlcyB0aGUgZXNjcm93ZWQgYGFtb3VudGAgdG8gYHBheWVlYCBvbiBiZWhhbGYgb2YgYW4gTS1vZi1OCnJlbGVhc2VyIHNldCAoZG9jcy9hZHIvMDAwNykuIEV2ZXJ5IGFkZHJlc3MgaW4gYGFwcHJvdmVyc2AgbXVzdCBiZSBhCnJlbGVhc2VyLCBhcHBlYXIgYXQgbW9zdCBvbmNlLCBhbmQgYXV0aG9yaXplIHRoaXMgZXhhY3QgaW52b2NhdGlvbjsKYXQgbGVhc3QgYHRocmVzaG9sZGAgZGlzdGluY3QgYXBwcm92ZXJzIGFyZSByZXF1aXJlZC4gQXBwcm92YWxzIGFyZQpub3Qgc3RvcmVkIGJldHdlZW4gY2FsbHMsIHNvIHRoZXJlIGlzIG5vdGhpbmcgdG8gY2xlYXIgb24gc2V0dGxlbWVudAphbmQgbm8gYXBwcm92YWwgdG8gcmVwbGF5IOKAlCBhIHNldHRsZWQgZXNjcm93IGZhaWxzIGBOb3RGdW5kZWRgLgAAAAAAABZyZWxlYXNlX3dpdGhfYXBwcm92YWxzAAAAAAACAAAAAAAAAAllc2Nyb3dfaWQAAAAAAAAGAAAAAAAAAAlhcHByb3ZlcnMAAAAAAAPqAAAAEwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAQZTYW1lIGFzIGBjcmVhdGVfZXNjcm93YCwgYnV0IGFsc28gcmVjb3JkcyB0aGUgb25seSBhZGRyZXNzIGFsbG93ZWQgdG8KYWRqdWRpY2F0ZSBhIGRpc3B1dGUgb3ZlciB0aGlzIGVzY3JvdyAoUGhhc2UgRTYsIGRvY3MvYWRyLzAwMDkpLgpPbWl0dGluZyB0aGlzIGVudHJ5IHBvaW50IChpLmUuIHVzaW5nIGBjcmVhdGVfZXNjcm93YCkga2VlcHMgdGhlCnByZS1FNiBiZWhhdmlvdXI6IG5vYm9keSBjYW4gcmVzb2x2ZSBhIGRpc3B1dGUgb24gdGhhdCBlc2Nyb3cuAAAAAAAaY3JlYXRlX2VzY3Jvd193aXRoX2FyYml0ZXIAAAAAAAkAAAAAAAAABXBheWVyAAAAAAAAEwAAAAAAAAAFcGF5ZWUAAAAAAAATAAAAAAAAAAV0b2tlbgAAAAAAABMAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAANY29uZGl0aW9uX3JlZgAAAAAAABAAAAAAAAAACHJlbGVhc2VyAAAAEwAAAAAAAAAMcmVmdW5kX2FmdGVyAAAD6AAAAAYAAAAAAAAAB2FyYml0ZXIAAAAAEwAAAAAAAAAMbm90aWZ5X3BheWVlAAAAAQAAAAEAAAPpAAAABgAAAAM=",
        "AAAAAAAAAZNTYW1lIGFzIGBjcmVhdGVfZXNjcm93YCwgYnV0IHRoZSBlc2Nyb3cgaXMgc2V0dGxlZCBieSBNLW9mLU4KcmVsZWFzZXJzIGluc3RlYWQgb2Ygb25lIGFkZHJlc3MgKGRvY3MvYWRyLzAwMDcpOiBgdGhyZXNob2xkYApkaXN0aW5jdCBhZGRyZXNzZXMgZnJvbSBgcmVsZWFzZXJzYCBtdXN0IGF1dGhvcml6ZSBhIHNldHRsZW1lbnQuClRoZSBzZXQgaXMgc3RvcmVkIGF0IGNyZWF0aW9uIGFuZCBjYW5ub3QgYmUgY2hhbmdlZCBhZnRlcndhcmRzIOKAlAp0aGVyZSBpcyBubyBhZG1pbiBhbmQgbm8gc2V0dGVyLiBSZWplY3RzIGFuIGVtcHR5IHNldCwgbW9yZSB0aGFuCjEwIHJlbGVhc2VycywgZHVwbGljYXRlIGFkZHJlc3NlcywgYW5kIGEgdGhyZXNob2xkIG9mIDAgb3Igb25lCmxhcmdlciB0aGFuIHRoZSBzZXQuAAAAABxjcmVhdGVfZXNjcm93X3dpdGhfcmVsZWFzZXJzAAAACQAAAAAAAAAFcGF5ZXIAAAAAAAATAAAAAAAAAAVwYXllZQAAAAAAABMAAAAAAAAABXRva2VuAAAAAAAAEwAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAA1jb25kaXRpb25fcmVmAAAAAAAAEAAAAAAAAAAJcmVsZWFzZXJzAAAAAAAD6gAAABMAAAAAAAAACXRocmVzaG9sZAAAAAAAAAQAAAAAAAAADHJlZnVuZF9hZnRlcgAAA+gAAAAGAAAAAAAAAAxub3RpZnlfcGF5ZWUAAAABAAAAAQAAA+kAAAAGAAAAAw==",
        "AAAAAAAAAIZDcmVhdGVzIGFuIGVzY3JvdyB3aXRoIGFuIG9wdC1pbiBwYXllZSBhY2NlcHRhbmNlIGdhdGUuIEV4aXN0aW5nCmludGVncmF0aW9ucyBjYW4ga2VlcCB1c2luZyBgY3JlYXRlX2VzY3Jvd2AsIHdoaWNoIGRlZmF1bHRzIHRoaXMgb2ZmLgAAAAAAHWNyZWF0ZV9lc2Nyb3dfd2l0aF9hY2NlcHRhbmNlAAAAAAAACAAAAAAAAAAFcGF5ZXIAAAAAAAATAAAAAAAAAAVwYXllZQAAAAAAABMAAAAAAAAABXRva2VuAAAAAAAAEwAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAA1jb25kaXRpb25fcmVmAAAAAAAAEAAAAAAAAAAIcmVsZWFzZXIAAAATAAAAAAAAAAxyZWZ1bmRfYWZ0ZXIAAAPoAAAABgAAAAAAAAATcmVxdWlyZXNfYWNjZXB0YW5jZQAAAAABAAAAAQAAA+kAAAAGAAAAAw==" ]),
      options
    )
  }
  public readonly fromJSON = {
    accept: this.txFromJSON<Result<void>>,
        refund: this.txFromJSON<Result<void>>,
        settle: this.txFromJSON<Result<void>>,
        top_up: this.txFromJSON<Result<void>>,
        release: this.txFromJSON<Result<void>>,
        get_escrow: this.txFromJSON<Result<EscrowData>>,
        get_status: this.txFromJSON<Result<EscrowStatus>>,
        get_dispute: this.txFromJSON<Result<DisputeState>>,
        create_escrow: this.txFromJSON<Result<u64>>,
        raise_dispute: this.txFromJSON<Result<void>>,
        resolve_dispute: this.txFromJSON<Result<void>>,
        refund_with_approvals: this.txFromJSON<Result<void>>,
        release_with_approvals: this.txFromJSON<Result<void>>,
        create_escrow_with_arbiter: this.txFromJSON<Result<u64>>,
        create_escrow_with_releasers: this.txFromJSON<Result<u64>>,
        create_escrow_with_acceptance: this.txFromJSON<Result<u64>>
  }
}