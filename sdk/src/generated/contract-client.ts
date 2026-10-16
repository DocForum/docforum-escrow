// GENERATED — do not hand-edit. Produced by:
//   stellar contract bindings typescript \
//     --wasm contracts/escrow/target/wasm32v1-none/release/docforum_escrow.wasm \
//     --output-dir <tmp-dir> --overwrite
// then this one file (src/index.ts in the generator's output) copied here.
// Regenerate whenever contracts/escrow/src/lib.rs's public function
// signatures, types, or doc comments change — the contract spec (and the
// doc comments you see below) come directly from the compiled wasm, not
// from anything typed by hand in this repo.
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
   * `accept`/`cancel` on an escrow created without
   * `requires_acceptance` — there is no acceptance step to race, so
   * neither exists for it (docs/adr/0005).
   */
  7: {message:"AcceptanceNotRequired"},
  /**
   * `accept` called twice, or `cancel` called after the payee
   * accepted — the cancellation window has closed (docs/adr/0005).
   */
  8: {message:"AlreadyAccepted"}
}


export interface EscrowData {
  /**
 * Set by the payee's `accept`. Always `false` when
 * `requires_acceptance` is false. Once true it never goes back.
 */
accepted: boolean;
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
 * The only address permitted to call `release`/`refund` on this
 * escrow. Set once at `create_escrow` time — see docs/adr/0002.
 */
releaser: string;
  /**
 * If true, the payee must call `accept` before the escrow is
 * committed; until then the payer may `cancel` (docs/adr/0005).
 * Fixed at `create_escrow` time.
 */
requires_acceptance: boolean;
  status: EscrowStatus;
  token: string;
}

export type EscrowStatus = {tag: "Funded", values: void} | {tag: "Released", values: void} | {tag: "Refunded", values: void} | {tag: "Cancelled", values: void};

export interface Client {
  /**
   * Construct and simulate a accept transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * The payee commits to an escrow created with `requires_acceptance`.
   * Requires `payee` auth and `payee` to equal the stored payee. Only
   * while `Funded`, and only once. Closes the payer's cancellation
   * window for good (docs/adr/0005). Moves no funds.
   */
  accept: ({escrow_id, payee}: {escrow_id: u64, payee: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a cancel transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Payer withdrawal: returns the escrowed `amount` to `payer` and
   * marks the escrow `Cancelled`. Allowed only while **all** hold:
   * 
   * - the escrow was created with `requires_acceptance` (otherwise
   * `AcceptanceNotRequired` — docs/adr/0005);
   * - the escrow is still `Funded` (so never after a release, a
   * refund, or any earlier payout — there is no partial-release
   * state in which cancelling could be reached);
   * - the payee has not called `accept` (otherwise `AlreadyAccepted`).
   * 
   * Requires `payer` auth and `payer` to equal the stored payer. The
   * destination is read from storage, so invariant I1 is unchanged.
   * Payees: do not rely on an escrow until you have accepted it.
   */
  cancel: ({escrow_id, payer}: {escrow_id: u64, payer: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a refund transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Returns the escrowed `amount` to `payer`. Same state rule as
   * `release` (only while `Funded`), but two callers are authorised:
   * 
   * - the escrow's `releaser` (docs/adr/0002), always; or
   * - **anyone**, once `refund_after` has been reached — the timeout
   * refund path for a lost/unsignable `releaser` key (docs/adr/0004).
   * 
   * The destination never changes: timeout or not, funds only ever go
   * back to the stored `payer`. With no `refund_after` set, behaviour
   * is identical to before the timeout existed — releaser only.
   */
  refund: ({escrow_id, caller}: {escrow_id: u64, caller: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a release transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Moves the escrowed `amount` to `payee`. Only the escrow's
   * `releaser` (set at `create_escrow` time) may call this — the
   * contract enforces WHO, never WHY (ADR 0001). Errors if the
   * escrow doesn't exist, `caller` isn't the releaser, or the escrow
   * isn't currently `Funded` (no double-release, no releasing a
   * refunded escrow).
   * 
   * Deliberately **not** gated by `refund_after` (docs/adr/0004): after
   * the deadline the releaser can still release, racing any timeout
   * refund — whoever lands first wins and the other fails `NotFunded`.
   */
  release: ({escrow_id, caller}: {escrow_id: u64, caller: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a get_escrow transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Read-only accessor for everything stored about `escrow_id` —
   * payer, payee, token, amount, `condition_ref`, status, `releaser`
   * and `refund_after`. Exists so payees and integrators can check
   * the deadline before relying on a `Funded` escrow (docs/adr/0004,
   * threat model T8). Errors on an unknown id.
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
   * tagged with an opaque `condition_ref`. `releaser` is the only
   * address that will later be permitted to call `release`/`refund`
   * on this escrow (see docs/adr/0002). `refund_after` is an optional
   * unix timestamp after which `refund` opens to any caller, always
   * back to `payer` (docs/adr/0004); `None` means no timeout.
   * `requires_acceptance` opts the escrow into the accept/cancel
   * protocol (docs/adr/0005): the payee may `accept`, and until they
   * do the payer may `cancel`. `false` leaves behaviour exactly as it
   * was before those functions existed.
   * Requires `payer` auth (the contract moves their funds). Returns
   * the new escrow's id.
   */
  create_escrow: ({payer, payee, token, amount, condition_ref, releaser, refund_after, requires_acceptance}: {payer: string, payee: string, token: string, amount: i128, condition_ref: string, releaser: string, refund_after: Option<u64>, requires_acceptance: boolean}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

}
export class Client extends ContractClient {
  static async deploy<T = Client>(
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
    return ContractClient.deploy(null, options)
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([ "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAACAAAAAAAAAAITm90Rm91bmQAAAABAAAAAAAAAA1JbnZhbGlkQW1vdW50AAAAAAAAAgAAAAAAAAAMVW5hdXRob3JpemVkAAAAAwAAAAAAAAAJTm90RnVuZGVkAAAAAAAABAAAALpgcmVmdW5kX2FmdGVyYCB3YXMgbm90IHN0cmljdGx5IGluIHRoZSBmdXR1cmUgYXQgY3JlYXRpb24g4oCUIHNlZQpkb2NzL2Fkci8wMDA0OiBhIGRlYWRsaW5lIHRoYXQgaGFzIGFscmVhZHkgcGFzc2VkIHdvdWxkIGxldAphbnlvbmUgcmVmdW5kIHRoZSBlc2Nyb3cgYmVmb3JlIHRoZSByZWxlYXNlciBjb3VsZCBldmVyIGFjdC4AAAAAABJJbnZhbGlkUmVmdW5kQWZ0ZXIAAAAAAAUAAACjVGhlIGNvbnRyYWN0J3MgdG9rZW4gYmFsYW5jZSBkaWRuJ3QgcmlzZSBieSBleGFjdGx5IGBhbW91bnRgCmFjcm9zcyBgY3JlYXRlX2VzY3Jvd2AncyB0cmFuc2ZlciAoYSBseWluZyBvciBzaG9ydC1kZWxpdmVyaW5nCnRva2VuKSDigJQgc2VlIGRvY3MvdGhyZWF0LW1vZGVsLm1kIFQ1LgAAAAAPQmFsYW5jZU1pc21hdGNoAAAAAAYAAACXYGFjY2VwdGAvYGNhbmNlbGAgb24gYW4gZXNjcm93IGNyZWF0ZWQgd2l0aG91dApgcmVxdWlyZXNfYWNjZXB0YW5jZWAg4oCUIHRoZXJlIGlzIG5vIGFjY2VwdGFuY2Ugc3RlcCB0byByYWNlLCBzbwpuZWl0aGVyIGV4aXN0cyBmb3IgaXQgKGRvY3MvYWRyLzAwMDUpLgAAAAAVQWNjZXB0YW5jZU5vdFJlcXVpcmVkAAAAAAAABwAAAHpgYWNjZXB0YCBjYWxsZWQgdHdpY2UsIG9yIGBjYW5jZWxgIGNhbGxlZCBhZnRlciB0aGUgcGF5ZWUKYWNjZXB0ZWQg4oCUIHRoZSBjYW5jZWxsYXRpb24gd2luZG93IGhhcyBjbG9zZWQgKGRvY3MvYWRyLzAwMDUpLgAAAAAAD0FscmVhZHlBY2NlcHRlZAAAAAAI",
        "AAAAAQAAAAAAAAAAAAAACkVzY3Jvd0RhdGEAAAAAAAoAAABuU2V0IGJ5IHRoZSBwYXllZSdzIGBhY2NlcHRgLiBBbHdheXMgYGZhbHNlYCB3aGVuCmByZXF1aXJlc19hY2NlcHRhbmNlYCBpcyBmYWxzZS4gT25jZSB0cnVlIGl0IG5ldmVyIGdvZXMgYmFjay4AAAAAAAhhY2NlcHRlZAAAAAEAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAANY29uZGl0aW9uX3JlZgAAAAAAABAAAAAAAAAABXBheWVlAAAAAAAAEwAAAAAAAAAFcGF5ZXIAAAAAAAATAAAAxk9wdGlvbmFsIGRlYWRsaW5lICh1bml4IHNlY29uZHMpIGFmdGVyIHdoaWNoIGByZWZ1bmRgIG9wZW5zIHRvCmFueW9uZSDigJQgc3RpbGwgb25seSBiYWNrIHRvIGBwYXllcmAuIGBOb25lYCBtZWFucyBubyB0aW1lb3V0LApiZWhhdmlvdXIgaWRlbnRpY2FsIHRvIGJlZm9yZSB0aGlzIGZpZWxkIGV4aXN0ZWQg4oCUIHNlZSBkb2NzL2Fkci8wMDA0LgAAAAAADHJlZnVuZF9hZnRlcgAAA+gAAAAGAAAAfVRoZSBvbmx5IGFkZHJlc3MgcGVybWl0dGVkIHRvIGNhbGwgYHJlbGVhc2VgL2ByZWZ1bmRgIG9uIHRoaXMKZXNjcm93LiBTZXQgb25jZSBhdCBgY3JlYXRlX2VzY3Jvd2AgdGltZSDigJQgc2VlIGRvY3MvYWRyLzAwMDIuAAAAAAAACHJlbGVhc2VyAAAAEwAAAJdJZiB0cnVlLCB0aGUgcGF5ZWUgbXVzdCBjYWxsIGBhY2NlcHRgIGJlZm9yZSB0aGUgZXNjcm93IGlzCmNvbW1pdHRlZDsgdW50aWwgdGhlbiB0aGUgcGF5ZXIgbWF5IGBjYW5jZWxgIChkb2NzL2Fkci8wMDA1KS4KRml4ZWQgYXQgYGNyZWF0ZV9lc2Nyb3dgIHRpbWUuAAAAABNyZXF1aXJlc19hY2NlcHRhbmNlAAAAAAEAAAAAAAAABnN0YXR1cwAAAAAH0AAAAAxFc2Nyb3dTdGF0dXMAAAAAAAAABXRva2VuAAAAAAAAEw==",
        "AAAAAgAAAAAAAAAAAAAADEVzY3Jvd1N0YXR1cwAAAAQAAAAAAAAAAAAAAAZGdW5kZWQAAAAAAAAAAAAAAAAACFJlbGVhc2VkAAAAAAAAAAAAAAAIUmVmdW5kZWQAAAAAAAAA2kVuZGVkIGJ5IHRoZSBwYXllcidzIGBjYW5jZWxgIGJlZm9yZSB0aGUgcGF5ZWUgYWNjZXB0ZWQg4oCUIGZ1bmRzCndlbnQgYmFjayB0byBgcGF5ZXJgLiBLZXB0IGRpc3RpbmN0IGZyb20gYFJlZnVuZGVkYCBzbyBhIHBheWVlIG9yCmludGVncmF0b3IgY2FuIHRlbGwgYSByZWxlYXNlci90aW1lb3V0IHJlZnVuZCBmcm9tIGEgcGF5ZXIKd2l0aGRyYXdhbCAoZG9jcy9hZHIvMDAwNSkuAAAAAAAJQ2FuY2VsbGVkAAAA",
        "AAAAAAAAAPRUaGUgcGF5ZWUgY29tbWl0cyB0byBhbiBlc2Nyb3cgY3JlYXRlZCB3aXRoIGByZXF1aXJlc19hY2NlcHRhbmNlYC4KUmVxdWlyZXMgYHBheWVlYCBhdXRoIGFuZCBgcGF5ZWVgIHRvIGVxdWFsIHRoZSBzdG9yZWQgcGF5ZWUuIE9ubHkKd2hpbGUgYEZ1bmRlZGAsIGFuZCBvbmx5IG9uY2UuIENsb3NlcyB0aGUgcGF5ZXIncyBjYW5jZWxsYXRpb24Kd2luZG93IGZvciBnb29kIChkb2NzL2Fkci8wMDA1KS4gTW92ZXMgbm8gZnVuZHMuAAAABmFjY2VwdAAAAAAAAgAAAAAAAAAJZXNjcm93X2lkAAAAAAAABgAAAAAAAAAFcGF5ZWUAAAAAAAATAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAApJQYXllciB3aXRoZHJhd2FsOiByZXR1cm5zIHRoZSBlc2Nyb3dlZCBgYW1vdW50YCB0byBgcGF5ZXJgIGFuZAptYXJrcyB0aGUgZXNjcm93IGBDYW5jZWxsZWRgLiBBbGxvd2VkIG9ubHkgd2hpbGUgKiphbGwqKiBob2xkOgoKLSB0aGUgZXNjcm93IHdhcyBjcmVhdGVkIHdpdGggYHJlcXVpcmVzX2FjY2VwdGFuY2VgIChvdGhlcndpc2UKYEFjY2VwdGFuY2VOb3RSZXF1aXJlZGAg4oCUIGRvY3MvYWRyLzAwMDUpOwotIHRoZSBlc2Nyb3cgaXMgc3RpbGwgYEZ1bmRlZGAgKHNvIG5ldmVyIGFmdGVyIGEgcmVsZWFzZSwgYQpyZWZ1bmQsIG9yIGFueSBlYXJsaWVyIHBheW91dCDigJQgdGhlcmUgaXMgbm8gcGFydGlhbC1yZWxlYXNlCnN0YXRlIGluIHdoaWNoIGNhbmNlbGxpbmcgY291bGQgYmUgcmVhY2hlZCk7Ci0gdGhlIHBheWVlIGhhcyBub3QgY2FsbGVkIGBhY2NlcHRgIChvdGhlcndpc2UgYEFscmVhZHlBY2NlcHRlZGApLgoKUmVxdWlyZXMgYHBheWVyYCBhdXRoIGFuZCBgcGF5ZXJgIHRvIGVxdWFsIHRoZSBzdG9yZWQgcGF5ZXIuIFRoZQpkZXN0aW5hdGlvbiBpcyByZWFkIGZyb20gc3RvcmFnZSwgc28gaW52YXJpYW50IEkxIGlzIHVuY2hhbmdlZC4KUGF5ZWVzOiBkbyBub3QgcmVseSBvbiBhbiBlc2Nyb3cgdW50aWwgeW91IGhhdmUgYWNjZXB0ZWQgaXQuAAAAAAAGY2FuY2VsAAAAAAACAAAAAAAAAAllc2Nyb3dfaWQAAAAAAAAGAAAAAAAAAAVwYXllcgAAAAAAABMAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAfxSZXR1cm5zIHRoZSBlc2Nyb3dlZCBgYW1vdW50YCB0byBgcGF5ZXJgLiBTYW1lIHN0YXRlIHJ1bGUgYXMKYHJlbGVhc2VgIChvbmx5IHdoaWxlIGBGdW5kZWRgKSwgYnV0IHR3byBjYWxsZXJzIGFyZSBhdXRob3Jpc2VkOgoKLSB0aGUgZXNjcm93J3MgYHJlbGVhc2VyYCAoZG9jcy9hZHIvMDAwMiksIGFsd2F5czsgb3IKLSAqKmFueW9uZSoqLCBvbmNlIGByZWZ1bmRfYWZ0ZXJgIGhhcyBiZWVuIHJlYWNoZWQg4oCUIHRoZSB0aW1lb3V0CnJlZnVuZCBwYXRoIGZvciBhIGxvc3QvdW5zaWduYWJsZSBgcmVsZWFzZXJgIGtleSAoZG9jcy9hZHIvMDAwNCkuCgpUaGUgZGVzdGluYXRpb24gbmV2ZXIgY2hhbmdlczogdGltZW91dCBvciBub3QsIGZ1bmRzIG9ubHkgZXZlciBnbwpiYWNrIHRvIHRoZSBzdG9yZWQgYHBheWVyYC4gV2l0aCBubyBgcmVmdW5kX2FmdGVyYCBzZXQsIGJlaGF2aW91cgppcyBpZGVudGljYWwgdG8gYmVmb3JlIHRoZSB0aW1lb3V0IGV4aXN0ZWQg4oCUIHJlbGVhc2VyIG9ubHkuAAAABnJlZnVuZAAAAAAAAgAAAAAAAAAJZXNjcm93X2lkAAAAAAAABgAAAAAAAAAGY2FsbGVyAAAAAAATAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAgxNb3ZlcyB0aGUgZXNjcm93ZWQgYGFtb3VudGAgdG8gYHBheWVlYC4gT25seSB0aGUgZXNjcm93J3MKYHJlbGVhc2VyYCAoc2V0IGF0IGBjcmVhdGVfZXNjcm93YCB0aW1lKSBtYXkgY2FsbCB0aGlzIOKAlCB0aGUKY29udHJhY3QgZW5mb3JjZXMgV0hPLCBuZXZlciBXSFkgKEFEUiAwMDAxKS4gRXJyb3JzIGlmIHRoZQplc2Nyb3cgZG9lc24ndCBleGlzdCwgYGNhbGxlcmAgaXNuJ3QgdGhlIHJlbGVhc2VyLCBvciB0aGUgZXNjcm93Cmlzbid0IGN1cnJlbnRseSBgRnVuZGVkYCAobm8gZG91YmxlLXJlbGVhc2UsIG5vIHJlbGVhc2luZyBhCnJlZnVuZGVkIGVzY3JvdykuCgpEZWxpYmVyYXRlbHkgKipub3QqKiBnYXRlZCBieSBgcmVmdW5kX2FmdGVyYCAoZG9jcy9hZHIvMDAwNCk6IGFmdGVyCnRoZSBkZWFkbGluZSB0aGUgcmVsZWFzZXIgY2FuIHN0aWxsIHJlbGVhc2UsIHJhY2luZyBhbnkgdGltZW91dApyZWZ1bmQg4oCUIHdob2V2ZXIgbGFuZHMgZmlyc3Qgd2lucyBhbmQgdGhlIG90aGVyIGZhaWxzIGBOb3RGdW5kZWRgLgAAAAdyZWxlYXNlAAAAAAIAAAAAAAAACWVzY3Jvd19pZAAAAAAAAAYAAAAAAAAABmNhbGxlcgAAAAAAEwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAASpSZWFkLW9ubHkgYWNjZXNzb3IgZm9yIGV2ZXJ5dGhpbmcgc3RvcmVkIGFib3V0IGBlc2Nyb3dfaWRgIOKAlApwYXllciwgcGF5ZWUsIHRva2VuLCBhbW91bnQsIGBjb25kaXRpb25fcmVmYCwgc3RhdHVzLCBgcmVsZWFzZXJgCmFuZCBgcmVmdW5kX2FmdGVyYC4gRXhpc3RzIHNvIHBheWVlcyBhbmQgaW50ZWdyYXRvcnMgY2FuIGNoZWNrCnRoZSBkZWFkbGluZSBiZWZvcmUgcmVseWluZyBvbiBhIGBGdW5kZWRgIGVzY3JvdyAoZG9jcy9hZHIvMDAwNCwKdGhyZWF0IG1vZGVsIFQ4KS4gRXJyb3JzIG9uIGFuIHVua25vd24gaWQuAAAAAAAKZ2V0X2VzY3JvdwAAAAAAAQAAAAAAAAAJZXNjcm93X2lkAAAAAAAABgAAAAEAAAPpAAAH0AAAAApFc2Nyb3dEYXRhAAAAAAAD",
        "AAAAAAAAADxSZWFkLW9ubHkgc3RhdHVzIHF1ZXJ5LiBFcnJvcnMgaWYgYGVzY3Jvd19pZGAgZG9lc24ndCBleGlzdC4AAAAKZ2V0X3N0YXR1cwAAAAAAAQAAAAAAAAAJZXNjcm93X2lkAAAAAAAABgAAAAEAAAPpAAAH0AAAAAxFc2Nyb3dTdGF0dXMAAAAD",
        "AAAAAAAAArNMb2NrcyBgYW1vdW50YCBvZiBgdG9rZW5gIHB1bGxlZCBmcm9tIGBwYXllcmAsIGhlbGQgZm9yIGBwYXllZWAsCnRhZ2dlZCB3aXRoIGFuIG9wYXF1ZSBgY29uZGl0aW9uX3JlZmAuIGByZWxlYXNlcmAgaXMgdGhlIG9ubHkKYWRkcmVzcyB0aGF0IHdpbGwgbGF0ZXIgYmUgcGVybWl0dGVkIHRvIGNhbGwgYHJlbGVhc2VgL2ByZWZ1bmRgCm9uIHRoaXMgZXNjcm93IChzZWUgZG9jcy9hZHIvMDAwMikuIGByZWZ1bmRfYWZ0ZXJgIGlzIGFuIG9wdGlvbmFsCnVuaXggdGltZXN0YW1wIGFmdGVyIHdoaWNoIGByZWZ1bmRgIG9wZW5zIHRvIGFueSBjYWxsZXIsIGFsd2F5cwpiYWNrIHRvIGBwYXllcmAgKGRvY3MvYWRyLzAwMDQpOyBgTm9uZWAgbWVhbnMgbm8gdGltZW91dC4KYHJlcXVpcmVzX2FjY2VwdGFuY2VgIG9wdHMgdGhlIGVzY3JvdyBpbnRvIHRoZSBhY2NlcHQvY2FuY2VsCnByb3RvY29sIChkb2NzL2Fkci8wMDA1KTogdGhlIHBheWVlIG1heSBgYWNjZXB0YCwgYW5kIHVudGlsIHRoZXkKZG8gdGhlIHBheWVyIG1heSBgY2FuY2VsYC4gYGZhbHNlYCBsZWF2ZXMgYmVoYXZpb3VyIGV4YWN0bHkgYXMgaXQKd2FzIGJlZm9yZSB0aG9zZSBmdW5jdGlvbnMgZXhpc3RlZC4KUmVxdWlyZXMgYHBheWVyYCBhdXRoICh0aGUgY29udHJhY3QgbW92ZXMgdGhlaXIgZnVuZHMpLiBSZXR1cm5zCnRoZSBuZXcgZXNjcm93J3MgaWQuAAAAAA1jcmVhdGVfZXNjcm93AAAAAAAACAAAAAAAAAAFcGF5ZXIAAAAAAAATAAAAAAAAAAVwYXllZQAAAAAAABMAAAAAAAAABXRva2VuAAAAAAAAEwAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAA1jb25kaXRpb25fcmVmAAAAAAAAEAAAAAAAAAAIcmVsZWFzZXIAAAATAAAAAAAAAAxyZWZ1bmRfYWZ0ZXIAAAPoAAAABgAAAAAAAAATcmVxdWlyZXNfYWNjZXB0YW5jZQAAAAABAAAAAQAAA+kAAAAGAAAAAw==" ]),
      options
    )
  }
  public readonly fromJSON = {
    accept: this.txFromJSON<Result<void>>,
        cancel: this.txFromJSON<Result<void>>,
        refund: this.txFromJSON<Result<void>>,
        release: this.txFromJSON<Result<void>>,
        get_escrow: this.txFromJSON<Result<EscrowData>>,
        get_status: this.txFromJSON<Result<EscrowStatus>>,
        create_escrow: this.txFromJSON<Result<u64>>
  }
}