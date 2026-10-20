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
  21: {message:"PoolInsufficient"},
  25: {message:"NotStreamed"},
  26: {message:"InvalidVestingSchedule"},
  27: {message:"NothingToWithdraw"},
  28: {message:"StreamTopUpUnsupported"}
}


export interface EscrowData {
  amount: i128;
  condition_ref: string;
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
  status: EscrowStatus;
  /**
 * How many *distinct* addresses from `releasers` must authorize one
 * settlement. Always `>= 1` and `<= releasers.len()`; `1` means any
 * single releaser can settle (the pre-quorum behaviour).
 */
threshold: u32;
  token: string;
}


export interface VestingInfo {
  claimable_amount: i128;
  schedule: VestingSchedule;
  total_amount: i128;
  vested_amount: i128;
  withdrawn_amount: i128;
}

export type EscrowStatus = {tag: "Funded", values: void} | {tag: "Released", values: void} | {tag: "Refunded", values: void};


/**
 * A stream vests linearly from `start` through `end`. A cliff delays
 * availability until its timestamp, then makes all accrued vesting claimable.
 */
export interface VestingSchedule {
  cliff: Option<u64>;
  end: u64;
  start: u64;
}

export interface Client {
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
   * Construct and simulate a withdraw transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Transfers the payee's vested but unwithdrawn stream amount.
   */
  withdraw: ({escrow_id, payee}: {escrow_id: u64, payee: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

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
   * Construct and simulate a get_vesting transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns current vested, withdrawn, and claimable amounts for a stream.
   */
  get_vesting: ({escrow_id}: {escrow_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<VestingInfo>>>

  /**
   * Construct and simulate a create_escrow transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Locks `amount` of `token` pulled from `payer`, held for `payee`,
   * tagged with an opaque `condition_ref` (max 64 bytes — see
   * docs/threat-model.md T10). `releaser` is the address permitted to
   * call `release`/`refund` on this escrow (docs/adr/0002).
   * `refund_after` is an optional unix timestamp after which `refund`
   * opens to any caller, always back to `payer` (docs/adr/0004).
   * Requires `payer` auth (the contract moves their funds). For an
   * M-of-N releaser set use `create_escrow_with_releasers` instead.
   */
  create_escrow: ({payer, payee, token, amount, condition_ref, releaser, refund_after}: {payer: string, payee: string, token: string, amount: i128, condition_ref: string, releaser: string, refund_after: Option<u64>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

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
   * Construct and simulate a create_streamed_escrow transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Creates a funded single-releaser escrow with a fixed-total linear vesting schedule.
   */
  create_streamed_escrow: ({payer, payee, token, amount, condition_ref, releaser, refund_after, schedule}: {payer: string, payee: string, token: string, amount: i128, condition_ref: string, releaser: string, refund_after: Option<u64>, schedule: VestingSchedule}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

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
   * Construct and simulate a create_escrow_with_releasers transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Same as `create_escrow`, but the escrow is settled by M-of-N
   * releasers instead of one address (docs/adr/0007): `threshold`
   * distinct addresses from `releasers` must authorize a settlement.
   * The set is stored at creation and cannot be changed afterwards —
   * there is no admin and no setter. Rejects an empty set, more than
   * 10 releasers, duplicate addresses, and a threshold of 0 or one
   * larger than the set.
   */
  create_escrow_with_releasers: ({payer, payee, token, amount, condition_ref, releasers, threshold, refund_after}: {payer: string, payee: string, token: string, amount: i128, condition_ref: string, releasers: Array<string>, threshold: u32, refund_after: Option<u64>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

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
      new ContractSpec([ "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAAEwAAAAAAAAAITm90Rm91bmQAAAABAAAAAAAAAA1JbnZhbGlkQW1vdW50AAAAAAAAAgAAAAAAAAAMVW5hdXRob3JpemVkAAAAAwAAAAAAAAAJTm90RnVuZGVkAAAAAAAABAAAALpgcmVmdW5kX2FmdGVyYCB3YXMgbm90IHN0cmljdGx5IGluIHRoZSBmdXR1cmUgYXQgY3JlYXRpb24g4oCUIHNlZQpkb2NzL2Fkci8wMDA0OiBhIGRlYWRsaW5lIHRoYXQgaGFzIGFscmVhZHkgcGFzc2VkIHdvdWxkIGxldAphbnlvbmUgcmVmdW5kIHRoZSBlc2Nyb3cgYmVmb3JlIHRoZSByZWxlYXNlciBjb3VsZCBldmVyIGFjdC4AAAAAABJJbnZhbGlkUmVmdW5kQWZ0ZXIAAAAAAAUAAACjVGhlIGNvbnRyYWN0J3MgdG9rZW4gYmFsYW5jZSBkaWRuJ3QgcmlzZSBieSBleGFjdGx5IGBhbW91bnRgCmFjcm9zcyBgY3JlYXRlX2VzY3Jvd2AncyB0cmFuc2ZlciAoYSBseWluZyBvciBzaG9ydC1kZWxpdmVyaW5nCnRva2VuKSDigJQgc2VlIGRvY3MvdGhyZWF0LW1vZGVsLm1kIFQ1LgAAAAAPQmFsYW5jZU1pc21hdGNoAAAAAAYAAAEAYGNvbmRpdGlvbl9yZWZgIGV4Y2VlZGVkIHRoZSBtYXhpbXVtIGFsbG93ZWQgbGVuZ3RoIChjdXJyZW50bHkKNjQgYnl0ZXMpIOKAlCBzZWUgZG9jcy90aHJlYXQtbW9kZWwubWQgVDEwIGFuZCBST0FETUFQLm1kIFBoYXNlIEU1LgpCb3VuZGVkIHRvIGtlZXAgc3RvcmFnZSBhbmQgZXZlbnQgY29zdHMgcHJlZGljdGFibGU7IHJlamVjdCBhdApjcmVhdGlvbiBzbyBubyBvbi1jaGFpbiBzdG9yYWdlIGlzIHdhc3RlZCBvbiBhbiBvdmVyc2l6ZWQgcmVmLgAAABNDb25kaXRpb25SZWZUb29Mb25nAAAAAAcAAAA2YHRva2VuYCBpcyBub3QgaW4gdGhlIGltbXV0YWJsZSBkZXBsb3ktdGltZSBhbGxvd2xpc3QuAAAAAAAPRGlzYWxsb3dlZFRva2VuAAAAAAgAAAAAAAAACE92ZXJmbG93AAAADAAAAGxUaGUgcmVsZWFzZXIgc2V0IGlzIGVtcHR5LCBvciBgdGhyZXNob2xkYCBpcyAwIG9yIGxhcmdlciB0aGFuIHRoZQpudW1iZXIgb2YgcmVsZWFzZXJzIOKAlCBzZWUgZG9jcy9hZHIvMDAwNy4AAAAQSW52YWxpZFRocmVzaG9sZAAAAA0AAABDTW9yZSB0aGFuIGBNQVhfUkVMRUFTRVJTYCAoMTApIGFkZHJlc3NlcyB3ZXJlIHN1cHBsaWVkIGF0IGNyZWF0aW9uLgAAAAAQVG9vTWFueVJlbGVhc2VycwAAAA4AAACfRmV3ZXIgZGlzdGluY3QgYXBwcm92YWxzIHdlcmUgc3VwcGxpZWQgdGhhbiB0aGUgZXNjcm93J3MgdGhyZXNob2xkLApvciBhIHNpbmdsZSByZWxlYXNlciB0cmllZCB0byBzZXR0bGUgYSBxdW9ydW0gZXNjcm93IHRocm91Z2ggdGhlCnNpbmdsZS1jYWxsZXIgZW50cnkgcG9pbnQuAAAAAA9UaHJlc2hvbGROb3RNZXQAAAAADwAAAGhUaGUgc2FtZSBhZGRyZXNzIGFwcGVhcmVkIHR3aWNlIGluIG9uZSBhcHByb3ZhbCBsaXN0LiBEdXBsaWNhdGVzCm5ldmVyIGNvdW50IHR3aWNlIHRvd2FyZCB0aGUgdGhyZXNob2xkLgAAABFEdXBsaWNhdGVBcHByb3ZlcgAAAAAAABAAAABAVGhlIHNhbWUgYWRkcmVzcyBhcHBlYXJlZCB0d2ljZSBpbiB0aGUgcmVsZWFzZXIgc2V0IGF0IGNyZWF0aW9uLgAAABFEdXBsaWNhdGVSZWxlYXNlcgAAAAAAABEAAAAAAAAAEFBvb2xJbnN1ZmZpY2llbnQAAAAVAAAAAAAAAAtOb3RTdHJlYW1lZAAAAAAZAAAAAAAAABZJbnZhbGlkVmVzdGluZ1NjaGVkdWxlAAAAAAAaAAAAAAAAABFOb3RoaW5nVG9XaXRoZHJhdwAAAAAAABsAAAAAAAAAFlN0cmVhbVRvcFVwVW5zdXBwb3J0ZWQAAAAAABw=",
        "AAAAAQAAAAAAAAAAAAAACkVzY3Jvd0RhdGEAAAAAAAkAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAANY29uZGl0aW9uX3JlZgAAAAAAABAAAAAAAAAABXBheWVlAAAAAAAAEwAAAAAAAAAFcGF5ZXIAAAAAAAATAAAAxk9wdGlvbmFsIGRlYWRsaW5lICh1bml4IHNlY29uZHMpIGFmdGVyIHdoaWNoIGByZWZ1bmRgIG9wZW5zIHRvCmFueW9uZSDigJQgc3RpbGwgb25seSBiYWNrIHRvIGBwYXllcmAuIGBOb25lYCBtZWFucyBubyB0aW1lb3V0LApiZWhhdmlvdXIgaWRlbnRpY2FsIHRvIGJlZm9yZSB0aGlzIGZpZWxkIGV4aXN0ZWQg4oCUIHNlZSBkb2NzL2Fkci8wMDA0LgAAAAAADHJlZnVuZF9hZnRlcgAAA+gAAAAGAAAAvUFkZHJlc3NlcyBwZXJtaXR0ZWQgdG8gc2V0dGxlIHRoaXMgZXNjcm93IOKAlCBzZWUgZG9jcy9hZHIvMDAwMiBmb3IgdGhlCnBlci1lc2Nyb3cgcmVsZWFzZXIsIGFuZCBkb2NzL2Fkci8wMDA3IGZvciBNLW9mLU4gc2V0cy4gQSBwbGFpbgpzaW5nbGUtcmVsZWFzZXIgZXNjcm93IHN0b3JlcyBleGFjdGx5IG9uZSBlbnRyeSBoZXJlLgAAAAAAAAlyZWxlYXNlcnMAAAAAAAPqAAAAEwAAAAAAAAAGc3RhdHVzAAAAAAfQAAAADEVzY3Jvd1N0YXR1cwAAALpIb3cgbWFueSAqZGlzdGluY3QqIGFkZHJlc3NlcyBmcm9tIGByZWxlYXNlcnNgIG11c3QgYXV0aG9yaXplIG9uZQpzZXR0bGVtZW50LiBBbHdheXMgYD49IDFgIGFuZCBgPD0gcmVsZWFzZXJzLmxlbigpYDsgYDFgIG1lYW5zIGFueQpzaW5nbGUgcmVsZWFzZXIgY2FuIHNldHRsZSAodGhlIHByZS1xdW9ydW0gYmVoYXZpb3VyKS4AAAAAAAl0aHJlc2hvbGQAAAAAAAAEAAAAAAAAAAV0b2tlbgAAAAAAABM=",
        "AAAAAQAAAAAAAAAAAAAAC1Zlc3RpbmdJbmZvAAAAAAUAAAAAAAAAEGNsYWltYWJsZV9hbW91bnQAAAALAAAAAAAAAAhzY2hlZHVsZQAAB9AAAAAPVmVzdGluZ1NjaGVkdWxlAAAAAAAAAAAMdG90YWxfYW1vdW50AAAACwAAAAAAAAANdmVzdGVkX2Ftb3VudAAAAAAAAAsAAAAAAAAAEHdpdGhkcmF3bl9hbW91bnQAAAAL",
        "AAAAAgAAAAAAAAAAAAAADEVzY3Jvd1N0YXR1cwAAAAMAAAAAAAAAAAAAAAZGdW5kZWQAAAAAAAAAAAAAAAAACFJlbGVhc2VkAAAAAAAAAAAAAAAIUmVmdW5kZWQ=",
        "AAAAAQAAAI5BIHN0cmVhbSB2ZXN0cyBsaW5lYXJseSBmcm9tIGBzdGFydGAgdGhyb3VnaCBgZW5kYC4gQSBjbGlmZiBkZWxheXMKYXZhaWxhYmlsaXR5IHVudGlsIGl0cyB0aW1lc3RhbXAsIHRoZW4gbWFrZXMgYWxsIGFjY3J1ZWQgdmVzdGluZyBjbGFpbWFibGUuAAAAAAAAAAAAD1Zlc3RpbmdTY2hlZHVsZQAAAAADAAAAAAAAAAVjbGlmZgAAAAAAA+gAAAAGAAAAAAAAAANlbmQAAAAABgAAAAAAAAAFc3RhcnQAAAAAAAAG",
        "AAAAAAAAAoVSZXR1cm5zIHRoZSBlc2Nyb3dlZCBgYW1vdW50YCB0byBgcGF5ZXJgLiBTYW1lIHN0YXRlIHJ1bGUgYXMKYHJlbGVhc2VgIChvbmx5IHdoaWxlIGBGdW5kZWRgKSwgYnV0IHR3byBjYWxsZXJzIGFyZSBhdXRob3Jpc2VkOgoKLSB0aGUgZXNjcm93J3MgcmVsZWFzZXIgKGRvY3MvYWRyLzAwMDIpLCBhbHdheXM7IG9yCi0gKiphbnlvbmUqKiwgb25jZSBgcmVmdW5kX2FmdGVyYCBoYXMgYmVlbiByZWFjaGVkIOKAlCB0aGUgdGltZW91dApyZWZ1bmQgcGF0aCBmb3IgYSBsb3N0L3Vuc2lnbmFibGUgcmVsZWFzZXIga2V5IChkb2NzL2Fkci8wMDA0KS4KClRoZSBkZXN0aW5hdGlvbiBuZXZlciBjaGFuZ2VzOiB0aW1lb3V0IG9yIG5vdCwgZnVuZHMgb25seSBldmVyIGdvCmJhY2sgdG8gdGhlIHN0b3JlZCBgcGF5ZXJgLiBXaXRoIG5vIGByZWZ1bmRfYWZ0ZXJgIHNldCwgYmVoYXZpb3VyCmlzIGlkZW50aWNhbCB0byBiZWZvcmUgdGhlIHRpbWVvdXQgZXhpc3RlZCDigJQgcmVsZWFzZXIgb25seS4gT24gYW4KTS1vZi1OIGVzY3JvdyB0aGUgcmVsZWFzZXIgcGF0aCBuZWVkcyBhIHRocmVzaG9sZCBvZiAxOyBvdGhlcndpc2UgdXNlCmByZWZ1bmRfd2l0aF9hcHByb3ZhbHNgICh0aGUgdGltZW91dCBwYXRoIHN0YXlzIG9wZW4gdG8gYW55b25lKS4AAAAAAAAGcmVmdW5kAAAAAAACAAAAAAAAAAllc2Nyb3dfaWQAAAAAAAAGAAAAAAAAAAZjYWxsZXIAAAAAABMAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAHVBZGRzIGZ1bmRzIHRvIGEgZnVuZGVkIGVzY3JvdyB3aXRob3V0IGNoYW5naW5nIGl0cyBwYXJ0aWVzIG9yIGlkLgpPbmx5IGl0cyBvcmlnaW5hbCBwYXllciBtYXkgYXV0aG9yaXplIHRoZSB0cmFuc2Zlci4AAAAAAAAGdG9wX3VwAAAAAAADAAAAAAAAAAllc2Nyb3dfaWQAAAAAAAAGAAAAAAAAAAVwYXllcgAAAAAAABMAAAAAAAAABmFtb3VudAAAAAAACwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAcxNb3ZlcyB0aGUgZXNjcm93ZWQgYGFtb3VudGAgdG8gYHBheWVlYC4gT25seSB0aGUgZXNjcm93J3MgcmVsZWFzZXIKbWF5IGNhbGwgdGhpcyDigJQgdGhlIGNvbnRyYWN0IGVuZm9yY2VzIFdITywgbmV2ZXIgV0hZIChBRFIgMDAwMSkuIE9uCmFuIE0tb2YtTiBlc2Nyb3cgdGhpcyBzaW5nbGUtY2FsbGVyIHBhdGggaXMgb25seSBhbGxvd2VkIHdoZW4gdGhlCnRocmVzaG9sZCBpcyAxOyBvdGhlcndpc2UgdXNlIGByZWxlYXNlX3dpdGhfYXBwcm92YWxzYC4KCkRlbGliZXJhdGVseSAqKm5vdCoqIGdhdGVkIGJ5IGByZWZ1bmRfYWZ0ZXJgIChkb2NzL2Fkci8wMDA0KTogYWZ0ZXIKdGhlIGRlYWRsaW5lIHRoZSByZWxlYXNlciBjYW4gc3RpbGwgcmVsZWFzZSwgcmFjaW5nIGFueSB0aW1lb3V0CnJlZnVuZCDigJQgd2hvZXZlciBsYW5kcyBmaXJzdCB3aW5zIGFuZCB0aGUgb3RoZXIgZmFpbHMgYE5vdEZ1bmRlZGAuAAAAB3JlbGVhc2UAAAAAAgAAAAAAAAAJZXNjcm93X2lkAAAAAAAABgAAAAAAAAAGY2FsbGVyAAAAAAATAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAADtUcmFuc2ZlcnMgdGhlIHBheWVlJ3MgdmVzdGVkIGJ1dCB1bndpdGhkcmF3biBzdHJlYW0gYW1vdW50LgAAAAAId2l0aGRyYXcAAAACAAAAAAAAAAllc2Nyb3dfaWQAAAAAAAAGAAAAAAAAAAVwYXllZQAAAAAAABMAAAABAAAD6QAAAAsAAAAD",
        "AAAAAAAAAU9SZWFkLW9ubHkgYWNjZXNzb3IgZm9yIGV2ZXJ5dGhpbmcgc3RvcmVkIGFib3V0IGBlc2Nyb3dfaWRgIOKAlCBwYXllciwKcGF5ZWUsIHRva2VuLCBhbW91bnQsIGBjb25kaXRpb25fcmVmYCwgc3RhdHVzLCB0aGUgcmVsZWFzZXIgc2V0IHdpdGgKaXRzIHRocmVzaG9sZCwgYW5kIGByZWZ1bmRfYWZ0ZXJgLiBFeGlzdHMgc28gcGF5ZWVzIGFuZCBpbnRlZ3JhdG9ycwpjYW4gY2hlY2sgd2hvIGNhbiBzZXR0bGUgYW5kIHdoZW4gYmVmb3JlIHJlbHlpbmcgb24gYSBgRnVuZGVkYAplc2Nyb3cgKGRvY3MvYWRyLzAwMDQsIHRocmVhdCBtb2RlbCBUOCkuIEVycm9ycyBvbiBhbiB1bmtub3duIGlkLgAAAAAKZ2V0X2VzY3JvdwAAAAAAAQAAAAAAAAAJZXNjcm93X2lkAAAAAAAABgAAAAEAAAPpAAAH0AAAAApFc2Nyb3dEYXRhAAAAAAAD",
        "AAAAAAAAADxSZWFkLW9ubHkgc3RhdHVzIHF1ZXJ5LiBFcnJvcnMgaWYgYGVzY3Jvd19pZGAgZG9lc24ndCBleGlzdC4AAAAKZ2V0X3N0YXR1cwAAAAAAAQAAAAAAAAAJZXNjcm93X2lkAAAAAAAABgAAAAEAAAPpAAAH0AAAAAxFc2Nyb3dTdGF0dXMAAAAD",
        "AAAAAAAAAEZSZXR1cm5zIGN1cnJlbnQgdmVzdGVkLCB3aXRoZHJhd24sIGFuZCBjbGFpbWFibGUgYW1vdW50cyBmb3IgYSBzdHJlYW0uAAAAAAALZ2V0X3Zlc3RpbmcAAAAAAQAAAAAAAAAJZXNjcm93X2lkAAAAAAAABgAAAAEAAAPpAAAH0AAAAAtWZXN0aW5nSW5mbwAAAAAD",
        "AAAAAAAAAHtTZXRzIHRoZSBpbW11dGFibGUgdG9rZW4gYWxsb3dsaXN0IGF0IGRlcGxveW1lbnQuIEFuIGVtcHR5IGxpc3QKcHJlc2VydmVzIHRoZSBsZWdhY3kgYmVoYXZpb3IgYW5kIGFsbG93cyBhbnkgdG9rZW4gYWRkcmVzcy4AAAAADV9fY29uc3RydWN0b3IAAAAAAAABAAAAAAAAAA5hbGxvd2VkX3Rva2VucwAAAAAD6gAAABMAAAAA",
        "AAAAAAAAAfRMb2NrcyBgYW1vdW50YCBvZiBgdG9rZW5gIHB1bGxlZCBmcm9tIGBwYXllcmAsIGhlbGQgZm9yIGBwYXllZWAsCnRhZ2dlZCB3aXRoIGFuIG9wYXF1ZSBgY29uZGl0aW9uX3JlZmAgKG1heCA2NCBieXRlcyDigJQgc2VlCmRvY3MvdGhyZWF0LW1vZGVsLm1kIFQxMCkuIGByZWxlYXNlcmAgaXMgdGhlIGFkZHJlc3MgcGVybWl0dGVkIHRvCmNhbGwgYHJlbGVhc2VgL2ByZWZ1bmRgIG9uIHRoaXMgZXNjcm93IChkb2NzL2Fkci8wMDAyKS4KYHJlZnVuZF9hZnRlcmAgaXMgYW4gb3B0aW9uYWwgdW5peCB0aW1lc3RhbXAgYWZ0ZXIgd2hpY2ggYHJlZnVuZGAKb3BlbnMgdG8gYW55IGNhbGxlciwgYWx3YXlzIGJhY2sgdG8gYHBheWVyYCAoZG9jcy9hZHIvMDAwNCkuClJlcXVpcmVzIGBwYXllcmAgYXV0aCAodGhlIGNvbnRyYWN0IG1vdmVzIHRoZWlyIGZ1bmRzKS4gRm9yIGFuCk0tb2YtTiByZWxlYXNlciBzZXQgdXNlIGBjcmVhdGVfZXNjcm93X3dpdGhfcmVsZWFzZXJzYCBpbnN0ZWFkLgAAAA1jcmVhdGVfZXNjcm93AAAAAAAABwAAAAAAAAAFcGF5ZXIAAAAAAAATAAAAAAAAAAVwYXllZQAAAAAAABMAAAAAAAAABXRva2VuAAAAAAAAEwAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAA1jb25kaXRpb25fcmVmAAAAAAAAEAAAAAAAAAAIcmVsZWFzZXIAAAATAAAAAAAAAAxyZWZ1bmRfYWZ0ZXIAAAPoAAAABgAAAAEAAAPpAAAABgAAAAM=",
        "AAAAAAAAASNSZXR1cm5zIHRoZSBlc2Nyb3dlZCBgYW1vdW50YCB0byBgcGF5ZXJgIG9uIGJlaGFsZiBvZiBhbiBNLW9mLU4KcmVsZWFzZXIgc2V0IChkb2NzL2Fkci8wMDA3KS4gU2FtZSBhcHByb3ZhbCBydWxlcyBhcwpgcmVsZWFzZV93aXRoX2FwcHJvdmFsc2AuIFRoZSB0aW1lb3V0IHJlZnVuZCBwYXRoIGluIGByZWZ1bmRgIHN0YXlzCmF2YWlsYWJsZSBhcyB3ZWxsOiBvbmNlIGByZWZ1bmRfYWZ0ZXJgIHBhc3NlcywgYW55b25lIGNhbiByZXR1cm4gdGhlCmZ1bmRzIHRvIHRoZSBwYXllciB3aXRob3V0IGFwcHJvdmFscy4AAAAAFXJlZnVuZF93aXRoX2FwcHJvdmFscwAAAAAAAAIAAAAAAAAACWVzY3Jvd19pZAAAAAAAAAYAAAAAAAAACWFwcHJvdmVycwAAAAAAA+oAAAATAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAFNDcmVhdGVzIGEgZnVuZGVkIHNpbmdsZS1yZWxlYXNlciBlc2Nyb3cgd2l0aCBhIGZpeGVkLXRvdGFsIGxpbmVhciB2ZXN0aW5nIHNjaGVkdWxlLgAAAAAWY3JlYXRlX3N0cmVhbWVkX2VzY3JvdwAAAAAACAAAAAAAAAAFcGF5ZXIAAAAAAAATAAAAAAAAAAVwYXllZQAAAAAAABMAAAAAAAAABXRva2VuAAAAAAAAEwAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAA1jb25kaXRpb25fcmVmAAAAAAAAEAAAAAAAAAAIcmVsZWFzZXIAAAATAAAAAAAAAAxyZWZ1bmRfYWZ0ZXIAAAPoAAAABgAAAAAAAAAIc2NoZWR1bGUAAAfQAAAAD1Zlc3RpbmdTY2hlZHVsZQAAAAABAAAD6QAAAAYAAAAD",
        "AAAAAAAAAZFNb3ZlcyB0aGUgZXNjcm93ZWQgYGFtb3VudGAgdG8gYHBheWVlYCBvbiBiZWhhbGYgb2YgYW4gTS1vZi1OCnJlbGVhc2VyIHNldCAoZG9jcy9hZHIvMDAwNykuIEV2ZXJ5IGFkZHJlc3MgaW4gYGFwcHJvdmVyc2AgbXVzdCBiZSBhCnJlbGVhc2VyLCBhcHBlYXIgYXQgbW9zdCBvbmNlLCBhbmQgYXV0aG9yaXplIHRoaXMgZXhhY3QgaW52b2NhdGlvbjsKYXQgbGVhc3QgYHRocmVzaG9sZGAgZGlzdGluY3QgYXBwcm92ZXJzIGFyZSByZXF1aXJlZC4gQXBwcm92YWxzIGFyZQpub3Qgc3RvcmVkIGJldHdlZW4gY2FsbHMsIHNvIHRoZXJlIGlzIG5vdGhpbmcgdG8gY2xlYXIgb24gc2V0dGxlbWVudAphbmQgbm8gYXBwcm92YWwgdG8gcmVwbGF5IOKAlCBhIHNldHRsZWQgZXNjcm93IGZhaWxzIGBOb3RGdW5kZWRgLgAAAAAAABZyZWxlYXNlX3dpdGhfYXBwcm92YWxzAAAAAAACAAAAAAAAAAllc2Nyb3dfaWQAAAAAAAAGAAAAAAAAAAlhcHByb3ZlcnMAAAAAAAPqAAAAEwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAZNTYW1lIGFzIGBjcmVhdGVfZXNjcm93YCwgYnV0IHRoZSBlc2Nyb3cgaXMgc2V0dGxlZCBieSBNLW9mLU4KcmVsZWFzZXJzIGluc3RlYWQgb2Ygb25lIGFkZHJlc3MgKGRvY3MvYWRyLzAwMDcpOiBgdGhyZXNob2xkYApkaXN0aW5jdCBhZGRyZXNzZXMgZnJvbSBgcmVsZWFzZXJzYCBtdXN0IGF1dGhvcml6ZSBhIHNldHRsZW1lbnQuClRoZSBzZXQgaXMgc3RvcmVkIGF0IGNyZWF0aW9uIGFuZCBjYW5ub3QgYmUgY2hhbmdlZCBhZnRlcndhcmRzIOKAlAp0aGVyZSBpcyBubyBhZG1pbiBhbmQgbm8gc2V0dGVyLiBSZWplY3RzIGFuIGVtcHR5IHNldCwgbW9yZSB0aGFuCjEwIHJlbGVhc2VycywgZHVwbGljYXRlIGFkZHJlc3NlcywgYW5kIGEgdGhyZXNob2xkIG9mIDAgb3Igb25lCmxhcmdlciB0aGFuIHRoZSBzZXQuAAAAABxjcmVhdGVfZXNjcm93X3dpdGhfcmVsZWFzZXJzAAAACAAAAAAAAAAFcGF5ZXIAAAAAAAATAAAAAAAAAAVwYXllZQAAAAAAABMAAAAAAAAABXRva2VuAAAAAAAAEwAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAA1jb25kaXRpb25fcmVmAAAAAAAAEAAAAAAAAAAJcmVsZWFzZXJzAAAAAAAD6gAAABMAAAAAAAAACXRocmVzaG9sZAAAAAAAAAQAAAAAAAAADHJlZnVuZF9hZnRlcgAAA+gAAAAGAAAAAQAAA+kAAAAGAAAAAw==" ]),
      options
    )
  }
  public readonly fromJSON = {
    refund: this.txFromJSON<Result<void>>,
        top_up: this.txFromJSON<Result<void>>,
        release: this.txFromJSON<Result<void>>,
        withdraw: this.txFromJSON<Result<i128>>,
        get_escrow: this.txFromJSON<Result<EscrowData>>,
        get_status: this.txFromJSON<Result<EscrowStatus>>,
        get_vesting: this.txFromJSON<Result<VestingInfo>>,
        create_escrow: this.txFromJSON<Result<u64>>,
        refund_with_approvals: this.txFromJSON<Result<void>>,
        create_streamed_escrow: this.txFromJSON<Result<u64>>,
        release_with_approvals: this.txFromJSON<Result<void>>,
        create_escrow_with_releasers: this.txFromJSON<Result<u64>>
  }
}