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
  23: {message:"ReleaseTooEarly"}
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

export type EscrowStatus = {tag: "Funded", values: void} | {tag: "Released", values: void} | {tag: "Refunded", values: void};

export interface Client {
  /**
   * Construct and simulate a accept transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Records the payee's acceptance for an opted-in funded escrow.
   */
  accept: ({escrow_id, payee}: {escrow_id: u64, payee: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

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
   * Construct and simulate a get_escrow transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Read-only accessor for everything stored about `escrow_id` — payer,
   * payee, token, amount, `condition_ref`, status, the releaser set with
   * its threshold, `refund_after` and `refund_to`. Exists so payees and
   * integrators can check who can settle, when, and where a refund goes
   * before relying on a `Funded` escrow (docs/adr/0004, threat model T8).
   * Errors on an unknown id.
   */
  get_escrow: ({escrow_id}: {escrow_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<EscrowData>>>

  /**
   * Construct and simulate a get_status transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Read-only status query. Errors if `escrow_id` doesn't exist.
   */
  get_status: ({escrow_id}: {escrow_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<EscrowStatus>>>

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
      new ContractSpec([ "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAAFQAAAAAAAAAITm90Rm91bmQAAAABAAAAAAAAAA1JbnZhbGlkQW1vdW50AAAAAAAAAgAAAAAAAAAMVW5hdXRob3JpemVkAAAAAwAAAAAAAAAJTm90RnVuZGVkAAAAAAAABAAAALpgcmVmdW5kX2FmdGVyYCB3YXMgbm90IHN0cmljdGx5IGluIHRoZSBmdXR1cmUgYXQgY3JlYXRpb24g4oCUIHNlZQpkb2NzL2Fkci8wMDA0OiBhIGRlYWRsaW5lIHRoYXQgaGFzIGFscmVhZHkgcGFzc2VkIHdvdWxkIGxldAphbnlvbmUgcmVmdW5kIHRoZSBlc2Nyb3cgYmVmb3JlIHRoZSByZWxlYXNlciBjb3VsZCBldmVyIGFjdC4AAAAAABJJbnZhbGlkUmVmdW5kQWZ0ZXIAAAAAAAUAAACjVGhlIGNvbnRyYWN0J3MgdG9rZW4gYmFsYW5jZSBkaWRuJ3QgcmlzZSBieSBleGFjdGx5IGBhbW91bnRgCmFjcm9zcyBgY3JlYXRlX2VzY3Jvd2AncyB0cmFuc2ZlciAoYSBseWluZyBvciBzaG9ydC1kZWxpdmVyaW5nCnRva2VuKSDigJQgc2VlIGRvY3MvdGhyZWF0LW1vZGVsLm1kIFQ1LgAAAAAPQmFsYW5jZU1pc21hdGNoAAAAAAYAAAEAYGNvbmRpdGlvbl9yZWZgIGV4Y2VlZGVkIHRoZSBtYXhpbXVtIGFsbG93ZWQgbGVuZ3RoIChjdXJyZW50bHkKNjQgYnl0ZXMpIOKAlCBzZWUgZG9jcy90aHJlYXQtbW9kZWwubWQgVDEwIGFuZCBST0FETUFQLm1kIFBoYXNlIEU1LgpCb3VuZGVkIHRvIGtlZXAgc3RvcmFnZSBhbmQgZXZlbnQgY29zdHMgcHJlZGljdGFibGU7IHJlamVjdCBhdApjcmVhdGlvbiBzbyBubyBvbi1jaGFpbiBzdG9yYWdlIGlzIHdhc3RlZCBvbiBhbiBvdmVyc2l6ZWQgcmVmLgAAABNDb25kaXRpb25SZWZUb29Mb25nAAAAAAcAAAA2YHRva2VuYCBpcyBub3QgaW4gdGhlIGltbXV0YWJsZSBkZXBsb3ktdGltZSBhbGxvd2xpc3QuAAAAAAAPRGlzYWxsb3dlZFRva2VuAAAAAAgAAACDVGhlIG9wdGVkLWluIHBheWVlIGNhbGxiYWNrIHJldHVybmVkIGFuIGVycm9yIG9yIGNvdWxkIG5vdCBiZQppbnZva2VkLiBUaGUgcmVsZWFzZSB0cmFuc2FjdGlvbiAoaW5jbHVkaW5nIGl0cyB0cmFuc2Zlcikgcm9sbHMgYmFjay4AAAAADkNhbGxiYWNrRmFpbGVkAAAAAAAJAAAAAAAAAAhPdmVyZmxvdwAAAAwAAABsVGhlIHJlbGVhc2VyIHNldCBpcyBlbXB0eSwgb3IgYHRocmVzaG9sZGAgaXMgMCBvciBsYXJnZXIgdGhhbiB0aGUKbnVtYmVyIG9mIHJlbGVhc2VycyDigJQgc2VlIGRvY3MvYWRyLzAwMDcuAAAAEEludmFsaWRUaHJlc2hvbGQAAAANAAAAQ01vcmUgdGhhbiBgTUFYX1JFTEVBU0VSU2AgKDEwKSBhZGRyZXNzZXMgd2VyZSBzdXBwbGllZCBhdCBjcmVhdGlvbi4AAAAAEFRvb01hbnlSZWxlYXNlcnMAAAAOAAAAn0Zld2VyIGRpc3RpbmN0IGFwcHJvdmFscyB3ZXJlIHN1cHBsaWVkIHRoYW4gdGhlIGVzY3JvdydzIHRocmVzaG9sZCwKb3IgYSBzaW5nbGUgcmVsZWFzZXIgdHJpZWQgdG8gc2V0dGxlIGEgcXVvcnVtIGVzY3JvdyB0aHJvdWdoIHRoZQpzaW5nbGUtY2FsbGVyIGVudHJ5IHBvaW50LgAAAAAPVGhyZXNob2xkTm90TWV0AAAAAA8AAABoVGhlIHNhbWUgYWRkcmVzcyBhcHBlYXJlZCB0d2ljZSBpbiBvbmUgYXBwcm92YWwgbGlzdC4gRHVwbGljYXRlcwpuZXZlciBjb3VudCB0d2ljZSB0b3dhcmQgdGhlIHRocmVzaG9sZC4AAAARRHVwbGljYXRlQXBwcm92ZXIAAAAAAAAQAAAAQFRoZSBzYW1lIGFkZHJlc3MgYXBwZWFyZWQgdHdpY2UgaW4gdGhlIHJlbGVhc2VyIHNldCBhdCBjcmVhdGlvbi4AAAARRHVwbGljYXRlUmVsZWFzZXIAAAAAAAARAAAAAAAAABJBY2NlcHRhbmNlUmVxdWlyZWQAAAAAABIAAAAAAAAAF0FjY2VwdGFuY2VOb3RDb25maWd1cmVkAAAAABMAAAAAAAAAD0FscmVhZHlBY2NlcHRlZAAAAAAUAAAAfGByZWZ1bmRfdG9gIHdhcyB0aGUgZXNjcm93IGNvbnRyYWN0J3Mgb3duIGFkZHJlc3Mg4oCUIGZ1bmRzIHNlbnQKdGhlcmUgb24gcmVmdW5kIGNvdWxkIG5ldmVyIGJlIG1vdmVkIGFnYWluIChkb2NzL2Fkci8wMDA5KS4AAAAPSW52YWxpZFJlZnVuZFRvAAAAABUAAABEVGhlIGNvbmZpZ3VyZWQgcmVsZWFzZSB0aW1lIGlzIGluIHRoZSBwYXN0IG9yIGFmdGVyIHRoZSByZWZ1bmQgdGltZS4AAAAXSW52YWxpZFJlbGVhc2VOb3RCZWZvcmUAAAAAFgAAADFSZWxlYXNlIHdhcyBhdHRlbXB0ZWQgYmVmb3JlIHRoZSBjb25maWd1cmVkIHRpbWUuAAAAAAAAD1JlbGVhc2VUb29FYXJseQAAAAAX",
        "AAAAAQAAAAAAAAAAAAAACkVzY3Jvd0RhdGEAAAAAAA4AAAA1TGVkZ2VyIHRpbWVzdGFtcCBhdCB3aGljaCB0aGUgcGF5ZWUgYWNjZXB0ZWQsIGlmIGFueS4AAAAAAAALYWNjZXB0ZWRfYXQAAAAD6AAAAAYAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAANY29uZGl0aW9uX3JlZgAAAAAAABAAAACGSWYgdHJ1ZSwgaW52b2tlIHRoZSBjb250cmFjdCBwYXllZSdzIGBvbl9lc2Nyb3dfcmVsZWFzZWRgIGhvb2sgYWZ0ZXIKdGhlIHBheW91dCB0cmFuc2Zlci4gQSBmYWlsZWQgY2FsbGJhY2sgcmV2ZXJ0cyB0aGUgd2hvbGUgcmVsZWFzZS4AAAAAAAxub3RpZnlfcGF5ZWUAAAABAAAAAAAAAAVwYXllZQAAAAAAABMAAAB6VGhlIGZ1bmRlcjogYXV0aG9yaXNlcyBhbmQgcGF5cyBmb3IgdGhlIGVzY3JvdyBhdCBjcmVhdGlvbi4gQWxzbwp0aGUgcmVmdW5kIGRlc3RpbmF0aW9uIHVubGVzcyBgcmVmdW5kX3RvYCBzYXlzIG90aGVyd2lzZS4AAAAAAAVwYXllcgAAAAAAABMAAADFT3B0aW9uYWwgZGVhZGxpbmUgKHVuaXggc2Vjb25kcykgYWZ0ZXIgd2hpY2ggYHJlZnVuZGAgb3BlbnMgdG8KYW55b25lIOKAlCBzdGlsbCBvbmx5IHRvIGByZWZ1bmRfdG9gLiBgTm9uZWAgbWVhbnMgbm8gdGltZW91dCwKYmVoYXZpb3VyIGlkZW50aWNhbCB0byBiZWZvcmUgdGhpcyBmaWVsZCBleGlzdGVkIOKAlCBzZWUgZG9jcy9hZHIvMDAwNC4AAAAAAAAMcmVmdW5kX2FmdGVyAAAD6AAAAAYAAADhV2hlcmUgKipldmVyeSoqIHJlZnVuZCBwYXRoIChyZWxlYXNlciwgdGltZW91dCkgc2VuZHMgdGhlIGZ1bmRzLgpGaXhlZCBhdCBjcmVhdGlvbiB1bmRlciB0aGUgZnVuZGVyJ3MgYXV0aCBhbmQgbmV2ZXIgY2hvc2VuIGF0CnBheW91dCwgc28gaW52YXJpYW50IEkxIGhvbGRzOyBkZWZhdWx0cyB0byBgcGF5ZXJgIHdoZW4gb21pdHRlZCBhdApjcmVhdGlvbiDigJQgc2VlIGRvY3MvYWRyLzAwMDkuAAAAAAAACXJlZnVuZF90bwAAAAAAABMAAAA2RWFybGllc3QgbGVkZ2VyIHRpbWVzdGFtcCBhdCB3aGljaCByZWxlYXNlIGlzIGFsbG93ZWQuAAAAAAAScmVsZWFzZV9ub3RfYmVmb3JlAAAAAAPoAAAABgAAAL1BZGRyZXNzZXMgcGVybWl0dGVkIHRvIHNldHRsZSB0aGlzIGVzY3JvdyDigJQgc2VlIGRvY3MvYWRyLzAwMDIgZm9yIHRoZQpwZXItZXNjcm93IHJlbGVhc2VyLCBhbmQgZG9jcy9hZHIvMDAwNyBmb3IgTS1vZi1OIHNldHMuIEEgcGxhaW4Kc2luZ2xlLXJlbGVhc2VyIGVzY3JvdyBzdG9yZXMgZXhhY3RseSBvbmUgZW50cnkgaGVyZS4AAAAAAAAJcmVsZWFzZXJzAAAAAAAD6gAAABMAAAA5V2hldGhlciByZWxlYXNlIHJlcXVpcmVzIHRoZSBwYXllZSdzIGV4cGxpY2l0IGFjY2VwdGFuY2UuAAAAAAAAE3JlcXVpcmVzX2FjY2VwdGFuY2UAAAAAAQAAAAAAAAAGc3RhdHVzAAAAAAfQAAAADEVzY3Jvd1N0YXR1cwAAALpIb3cgbWFueSAqZGlzdGluY3QqIGFkZHJlc3NlcyBmcm9tIGByZWxlYXNlcnNgIG11c3QgYXV0aG9yaXplIG9uZQpzZXR0bGVtZW50LiBBbHdheXMgYD49IDFgIGFuZCBgPD0gcmVsZWFzZXJzLmxlbigpYDsgYDFgIG1lYW5zIGFueQpzaW5nbGUgcmVsZWFzZXIgY2FuIHNldHRsZSAodGhlIHByZS1xdW9ydW0gYmVoYXZpb3VyKS4AAAAAAAl0aHJlc2hvbGQAAAAAAAAEAAAAAAAAAAV0b2tlbgAAAAAAABM=",
        "AAAAAgAAAAAAAAAAAAAADEVzY3Jvd1N0YXR1cwAAAAMAAAAAAAAAAAAAAAZGdW5kZWQAAAAAAAAAAAAAAAAACFJlbGVhc2VkAAAAAAAAAAAAAAAIUmVmdW5kZWQ=",
        "AAAAAAAAAD1SZWNvcmRzIHRoZSBwYXllZSdzIGFjY2VwdGFuY2UgZm9yIGFuIG9wdGVkLWluIGZ1bmRlZCBlc2Nyb3cuAAAAAAAABmFjY2VwdAAAAAAAAgAAAAAAAAAJZXNjcm93X2lkAAAAAAAABgAAAAAAAAAFcGF5ZWUAAAAAAAATAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAwlSZXR1cm5zIHRoZSBlc2Nyb3dlZCBgYW1vdW50YCB0byB0aGUgZXNjcm93J3MgYHJlZnVuZF90b2AgKHRoZQpgcGF5ZXJgIHVubGVzcyBhIGRpZmZlcmVudCBkZXN0aW5hdGlvbiB3YXMgZml4ZWQgYXQgY3JlYXRpb24g4oCUCmRvY3MvYWRyLzAwMDYpLiBTYW1lIHN0YXRlIHJ1bGUgYXMKYHJlbGVhc2VgIChvbmx5IHdoaWxlIGBGdW5kZWRgKSwgYnV0IHR3byBjYWxsZXJzIGFyZSBhdXRob3Jpc2VkOgoKLSB0aGUgZXNjcm93J3MgcmVsZWFzZXIgKGRvY3MvYWRyLzAwMDIpLCBhbHdheXM7IG9yCi0gKiphbnlvbmUqKiwgb25jZSBgcmVmdW5kX2FmdGVyYCBoYXMgYmVlbiByZWFjaGVkIOKAlCB0aGUgdGltZW91dApyZWZ1bmQgcGF0aCBmb3IgYSBsb3N0L3Vuc2lnbmFibGUgcmVsZWFzZXIga2V5IChkb2NzL2Fkci8wMDA0KS4KClRoZSBkZXN0aW5hdGlvbiBuZXZlciBjaGFuZ2VzOiB0aW1lb3V0IG9yIG5vdCwgZnVuZHMgb25seSBldmVyIGdvCnRvIHRoZSBzdG9yZWQgYHJlZnVuZF90b2AsIHdoaWNoIG5vIGNhbGxlciBjYW4gaW5mbHVlbmNlLiBXaXRoIG5vCmByZWZ1bmRfYWZ0ZXJgIHNldCwgYmVoYXZpb3VyIGlzIGlkZW50aWNhbCB0byBiZWZvcmUgdGhlIHRpbWVvdXQKZXhpc3RlZCDigJQgcmVsZWFzZXIgb25seS4gT24gYW4gTS1vZi1OIGVzY3JvdyB0aGUgcmVsZWFzZXIgcGF0aCBuZWVkcwphIHRocmVzaG9sZCBvZiAxOyBvdGhlcndpc2UgdXNlIGByZWZ1bmRfd2l0aF9hcHByb3ZhbHNgICh0aGUgdGltZW91dApwYXRoIHN0YXlzIG9wZW4gdG8gYW55b25lKS4AAAAAAAAGcmVmdW5kAAAAAAACAAAAAAAAAAllc2Nyb3dfaWQAAAAAAAAGAAAAAAAAAAZjYWxsZXIAAAAAABMAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAHVBZGRzIGZ1bmRzIHRvIGEgZnVuZGVkIGVzY3JvdyB3aXRob3V0IGNoYW5naW5nIGl0cyBwYXJ0aWVzIG9yIGlkLgpPbmx5IGl0cyBvcmlnaW5hbCBwYXllciBtYXkgYXV0aG9yaXplIHRoZSB0cmFuc2Zlci4AAAAAAAAGdG9wX3VwAAAAAAADAAAAAAAAAAllc2Nyb3dfaWQAAAAAAAAGAAAAAAAAAAVwYXllcgAAAAAAABMAAAAAAAAABmFtb3VudAAAAAAACwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAcxNb3ZlcyB0aGUgZXNjcm93ZWQgYGFtb3VudGAgdG8gYHBheWVlYC4gT25seSB0aGUgZXNjcm93J3MgcmVsZWFzZXIKbWF5IGNhbGwgdGhpcyDigJQgdGhlIGNvbnRyYWN0IGVuZm9yY2VzIFdITywgbmV2ZXIgV0hZIChBRFIgMDAwMSkuIE9uCmFuIE0tb2YtTiBlc2Nyb3cgdGhpcyBzaW5nbGUtY2FsbGVyIHBhdGggaXMgb25seSBhbGxvd2VkIHdoZW4gdGhlCnRocmVzaG9sZCBpcyAxOyBvdGhlcndpc2UgdXNlIGByZWxlYXNlX3dpdGhfYXBwcm92YWxzYC4KCkRlbGliZXJhdGVseSAqKm5vdCoqIGdhdGVkIGJ5IGByZWZ1bmRfYWZ0ZXJgIChkb2NzL2Fkci8wMDA0KTogYWZ0ZXIKdGhlIGRlYWRsaW5lIHRoZSByZWxlYXNlciBjYW4gc3RpbGwgcmVsZWFzZSwgcmFjaW5nIGFueSB0aW1lb3V0CnJlZnVuZCDigJQgd2hvZXZlciBsYW5kcyBmaXJzdCB3aW5zIGFuZCB0aGUgb3RoZXIgZmFpbHMgYE5vdEZ1bmRlZGAuAAAAB3JlbGVhc2UAAAAAAgAAAAAAAAAJZXNjcm93X2lkAAAAAAAABgAAAAAAAAAGY2FsbGVyAAAAAAATAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAXFSZWFkLW9ubHkgYWNjZXNzb3IgZm9yIGV2ZXJ5dGhpbmcgc3RvcmVkIGFib3V0IGBlc2Nyb3dfaWRgIOKAlCBwYXllciwKcGF5ZWUsIHRva2VuLCBhbW91bnQsIGBjb25kaXRpb25fcmVmYCwgc3RhdHVzLCB0aGUgcmVsZWFzZXIgc2V0IHdpdGgKaXRzIHRocmVzaG9sZCwgYHJlZnVuZF9hZnRlcmAgYW5kIGByZWZ1bmRfdG9gLiBFeGlzdHMgc28gcGF5ZWVzIGFuZAppbnRlZ3JhdG9ycyBjYW4gY2hlY2sgd2hvIGNhbiBzZXR0bGUsIHdoZW4sIGFuZCB3aGVyZSBhIHJlZnVuZCBnb2VzCmJlZm9yZSByZWx5aW5nIG9uIGEgYEZ1bmRlZGAgZXNjcm93IChkb2NzL2Fkci8wMDA0LCB0aHJlYXQgbW9kZWwgVDgpLgpFcnJvcnMgb24gYW4gdW5rbm93biBpZC4AAAAAAAAKZ2V0X2VzY3JvdwAAAAAAAQAAAAAAAAAJZXNjcm93X2lkAAAAAAAABgAAAAEAAAPpAAAH0AAAAApFc2Nyb3dEYXRhAAAAAAAD",
        "AAAAAAAAADxSZWFkLW9ubHkgc3RhdHVzIHF1ZXJ5LiBFcnJvcnMgaWYgYGVzY3Jvd19pZGAgZG9lc24ndCBleGlzdC4AAAAKZ2V0X3N0YXR1cwAAAAAAAQAAAAAAAAAJZXNjcm93X2lkAAAAAAAABgAAAAEAAAPpAAAH0AAAAAxFc2Nyb3dTdGF0dXMAAAAD",
        "AAAAAAAAAHtTZXRzIHRoZSBpbW11dGFibGUgdG9rZW4gYWxsb3dsaXN0IGF0IGRlcGxveW1lbnQuIEFuIGVtcHR5IGxpc3QKcHJlc2VydmVzIHRoZSBsZWdhY3kgYmVoYXZpb3IgYW5kIGFsbG93cyBhbnkgdG9rZW4gYWRkcmVzcy4AAAAADV9fY29uc3RydWN0b3IAAAAAAAABAAAAAAAAAA5hbGxvd2VkX3Rva2VucwAAAAAD6gAAABMAAAAA",
        "AAAAAAAAAw9Mb2NrcyBgYW1vdW50YCBvZiBgdG9rZW5gIHB1bGxlZCBmcm9tIGBwYXllcmAsIGhlbGQgZm9yIGBwYXllZWAsCmRvY3MvdGhyZWF0LW1vZGVsLm1kIFQxMCBhbmQgUk9BRE1BUC5tZCBQaGFzZSBFNSkuIGByZWxlYXNlcmAgaXMgdGhlCmFkZHJlc3MgcGVybWl0dGVkIHRvIGNhbGwgYHJlbGVhc2VgL2ByZWZ1bmRgIG9uIHRoaXMgZXNjcm93Cihkb2NzL2Fkci8wMDAyKS4gYHJlZnVuZF9hZnRlcmAgaXMgb3B0aW9uYWwgKGRvY3MvYWRyLzAwMDQpLgpgbm90aWZ5X3BheWVlYCBvcHRzIGFuIGltcGxlbWVudGluZyBjb250cmFjdCBwYXllZSBpbnRvCmBvbl9lc2Nyb3dfcmVsZWFzZWQoZXNjcm93X2lkLCBhbW91bnQpYCAoZG9jcy9hZHIvMDAwNSkuIFRoZSBwYXllcgptdXN0IGF1dGhvcml6ZSBjcmVhdGlvbiwgYW5kIHRoZSBwYXllZSBtdXN0IGFsc28gYXV0aG9yaXplIGlmCmBub3RpZnlfcGF5ZWVgIGlzIHRydWUuIGByZWZ1bmRfdG9gIGlzIHRoZSBvcHRpb25hbCByZWZ1bmQKZGVzdGluYXRpb24gZm9yIGEgc3BvbnNvcmVkIGVzY3JvdyB3aGVyZSB0aGUgZnVuZGVyIChgcGF5ZXJgKSBpcwpub3Qgd2hvIHNob3VsZCBnZXQgdGhlIG1vbmV5IGJhY2sgKGRvY3MvYWRyLzAwMDkpOiBgTm9uZWAgbWVhbnMKYHBheWVyYDsgaXQgbWF5IG5vdCBiZSB0aGlzIGNvbnRyYWN0J3Mgb3duIGFkZHJlc3MsIGFuZCB0aGUKYHBheWVyYCdzIGF1dGggb24gdGhpcyBjYWxsIGNvdmVycyBpdC4gRm9yIE0tb2YtTiByZWxlYXNlcnMgdXNlCmBjcmVhdGVfZXNjcm93X3dpdGhfcmVsZWFzZXJzYC4AAAAADWNyZWF0ZV9lc2Nyb3cAAAAAAAAJAAAAAAAAAAVwYXllcgAAAAAAABMAAAAAAAAABXBheWVlAAAAAAAAEwAAAAAAAAAFdG9rZW4AAAAAAAATAAAAAAAAAAZhbW91bnQAAAAAAAsAAAAAAAAADWNvbmRpdGlvbl9yZWYAAAAAAAAQAAAAAAAAAAhyZWxlYXNlcgAAABMAAAAAAAAADHJlZnVuZF9hZnRlcgAAA+gAAAAGAAAAAAAAAAxub3RpZnlfcGF5ZWUAAAABAAAAAAAAAAlyZWZ1bmRfdG8AAAAAAAPoAAAAEwAAAAEAAAPpAAAABgAAAAM=",
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
        refund: this.txFromJSON<Result<void>>,
        top_up: this.txFromJSON<Result<void>>,
        release: this.txFromJSON<Result<void>>,
        get_escrow: this.txFromJSON<Result<EscrowData>>,
        get_status: this.txFromJSON<Result<EscrowStatus>>,
        create_escrow: this.txFromJSON<Result<u64>>,
        refund_with_approvals: this.txFromJSON<Result<void>>,
        release_with_approvals: this.txFromJSON<Result<void>>,
        create_escrow_release_time: this.txFromJSON<Result<u64>>,
        create_escrow_with_releasers: this.txFromJSON<Result<u64>>,
        create_escrow_with_acceptance: this.txFromJSON<Result<u64>>
  }
}