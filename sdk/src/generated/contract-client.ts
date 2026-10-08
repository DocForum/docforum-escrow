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
  5: {message:"InvalidRefundAfter"}
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
 * The only address permitted to call `release`/`refund` on this
 * escrow. Set once at `create_escrow` time — see docs/adr/0002.
 */
releaser: string;
  status: EscrowStatus;
  token: string;
}

export type EscrowStatus = {tag: "Funded", values: void} | {tag: "Released", values: void} | {tag: "Refunded", values: void};

export interface Client {
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
   * Requires `payer` auth (the contract moves their funds). Returns
   * the new escrow's id.
   */
  create_escrow: ({payer, payee, token, amount, condition_ref, releaser, refund_after}: {payer: string, payee: string, token: string, amount: i128, condition_ref: string, releaser: string, refund_after: Option<u64>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

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
      new ContractSpec([ "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAABQAAAAAAAAAITm90Rm91bmQAAAABAAAAAAAAAA1JbnZhbGlkQW1vdW50AAAAAAAAAgAAAAAAAAAMVW5hdXRob3JpemVkAAAAAwAAAAAAAAAJTm90RnVuZGVkAAAAAAAABAAAALpgcmVmdW5kX2FmdGVyYCB3YXMgbm90IHN0cmljdGx5IGluIHRoZSBmdXR1cmUgYXQgY3JlYXRpb24g4oCUIHNlZQpkb2NzL2Fkci8wMDA0OiBhIGRlYWRsaW5lIHRoYXQgaGFzIGFscmVhZHkgcGFzc2VkIHdvdWxkIGxldAphbnlvbmUgcmVmdW5kIHRoZSBlc2Nyb3cgYmVmb3JlIHRoZSByZWxlYXNlciBjb3VsZCBldmVyIGFjdC4AAAAAABJJbnZhbGlkUmVmdW5kQWZ0ZXIAAAAAAAU=",
        "AAAAAQAAAAAAAAAAAAAACkVzY3Jvd0RhdGEAAAAAAAgAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAANY29uZGl0aW9uX3JlZgAAAAAAABAAAAAAAAAABXBheWVlAAAAAAAAEwAAAAAAAAAFcGF5ZXIAAAAAAAATAAAAxk9wdGlvbmFsIGRlYWRsaW5lICh1bml4IHNlY29uZHMpIGFmdGVyIHdoaWNoIGByZWZ1bmRgIG9wZW5zIHRvCmFueW9uZSDigJQgc3RpbGwgb25seSBiYWNrIHRvIGBwYXllcmAuIGBOb25lYCBtZWFucyBubyB0aW1lb3V0LApiZWhhdmlvdXIgaWRlbnRpY2FsIHRvIGJlZm9yZSB0aGlzIGZpZWxkIGV4aXN0ZWQg4oCUIHNlZSBkb2NzL2Fkci8wMDA0LgAAAAAADHJlZnVuZF9hZnRlcgAAA+gAAAAGAAAAfVRoZSBvbmx5IGFkZHJlc3MgcGVybWl0dGVkIHRvIGNhbGwgYHJlbGVhc2VgL2ByZWZ1bmRgIG9uIHRoaXMKZXNjcm93LiBTZXQgb25jZSBhdCBgY3JlYXRlX2VzY3Jvd2AgdGltZSDigJQgc2VlIGRvY3MvYWRyLzAwMDIuAAAAAAAACHJlbGVhc2VyAAAAEwAAAAAAAAAGc3RhdHVzAAAAAAfQAAAADEVzY3Jvd1N0YXR1cwAAAAAAAAAFdG9rZW4AAAAAAAAT",
        "AAAAAgAAAAAAAAAAAAAADEVzY3Jvd1N0YXR1cwAAAAMAAAAAAAAAAAAAAAZGdW5kZWQAAAAAAAAAAAAAAAAACFJlbGVhc2VkAAAAAAAAAAAAAAAIUmVmdW5kZWQ=",
        "AAAAAAAAAfxSZXR1cm5zIHRoZSBlc2Nyb3dlZCBgYW1vdW50YCB0byBgcGF5ZXJgLiBTYW1lIHN0YXRlIHJ1bGUgYXMKYHJlbGVhc2VgIChvbmx5IHdoaWxlIGBGdW5kZWRgKSwgYnV0IHR3byBjYWxsZXJzIGFyZSBhdXRob3Jpc2VkOgoKLSB0aGUgZXNjcm93J3MgYHJlbGVhc2VyYCAoZG9jcy9hZHIvMDAwMiksIGFsd2F5czsgb3IKLSAqKmFueW9uZSoqLCBvbmNlIGByZWZ1bmRfYWZ0ZXJgIGhhcyBiZWVuIHJlYWNoZWQg4oCUIHRoZSB0aW1lb3V0CnJlZnVuZCBwYXRoIGZvciBhIGxvc3QvdW5zaWduYWJsZSBgcmVsZWFzZXJgIGtleSAoZG9jcy9hZHIvMDAwNCkuCgpUaGUgZGVzdGluYXRpb24gbmV2ZXIgY2hhbmdlczogdGltZW91dCBvciBub3QsIGZ1bmRzIG9ubHkgZXZlciBnbwpiYWNrIHRvIHRoZSBzdG9yZWQgYHBheWVyYC4gV2l0aCBubyBgcmVmdW5kX2FmdGVyYCBzZXQsIGJlaGF2aW91cgppcyBpZGVudGljYWwgdG8gYmVmb3JlIHRoZSB0aW1lb3V0IGV4aXN0ZWQg4oCUIHJlbGVhc2VyIG9ubHkuAAAABnJlZnVuZAAAAAAAAgAAAAAAAAAJZXNjcm93X2lkAAAAAAAABgAAAAAAAAAGY2FsbGVyAAAAAAATAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAgxNb3ZlcyB0aGUgZXNjcm93ZWQgYGFtb3VudGAgdG8gYHBheWVlYC4gT25seSB0aGUgZXNjcm93J3MKYHJlbGVhc2VyYCAoc2V0IGF0IGBjcmVhdGVfZXNjcm93YCB0aW1lKSBtYXkgY2FsbCB0aGlzIOKAlCB0aGUKY29udHJhY3QgZW5mb3JjZXMgV0hPLCBuZXZlciBXSFkgKEFEUiAwMDAxKS4gRXJyb3JzIGlmIHRoZQplc2Nyb3cgZG9lc24ndCBleGlzdCwgYGNhbGxlcmAgaXNuJ3QgdGhlIHJlbGVhc2VyLCBvciB0aGUgZXNjcm93Cmlzbid0IGN1cnJlbnRseSBgRnVuZGVkYCAobm8gZG91YmxlLXJlbGVhc2UsIG5vIHJlbGVhc2luZyBhCnJlZnVuZGVkIGVzY3JvdykuCgpEZWxpYmVyYXRlbHkgKipub3QqKiBnYXRlZCBieSBgcmVmdW5kX2FmdGVyYCAoZG9jcy9hZHIvMDAwNCk6IGFmdGVyCnRoZSBkZWFkbGluZSB0aGUgcmVsZWFzZXIgY2FuIHN0aWxsIHJlbGVhc2UsIHJhY2luZyBhbnkgdGltZW91dApyZWZ1bmQg4oCUIHdob2V2ZXIgbGFuZHMgZmlyc3Qgd2lucyBhbmQgdGhlIG90aGVyIGZhaWxzIGBOb3RGdW5kZWRgLgAAAAdyZWxlYXNlAAAAAAIAAAAAAAAACWVzY3Jvd19pZAAAAAAAAAYAAAAAAAAABmNhbGxlcgAAAAAAEwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAASpSZWFkLW9ubHkgYWNjZXNzb3IgZm9yIGV2ZXJ5dGhpbmcgc3RvcmVkIGFib3V0IGBlc2Nyb3dfaWRgIOKAlApwYXllciwgcGF5ZWUsIHRva2VuLCBhbW91bnQsIGBjb25kaXRpb25fcmVmYCwgc3RhdHVzLCBgcmVsZWFzZXJgCmFuZCBgcmVmdW5kX2FmdGVyYC4gRXhpc3RzIHNvIHBheWVlcyBhbmQgaW50ZWdyYXRvcnMgY2FuIGNoZWNrCnRoZSBkZWFkbGluZSBiZWZvcmUgcmVseWluZyBvbiBhIGBGdW5kZWRgIGVzY3JvdyAoZG9jcy9hZHIvMDAwNCwKdGhyZWF0IG1vZGVsIFQ4KS4gRXJyb3JzIG9uIGFuIHVua25vd24gaWQuAAAAAAAKZ2V0X2VzY3JvdwAAAAAAAQAAAAAAAAAJZXNjcm93X2lkAAAAAAAABgAAAAEAAAPpAAAH0AAAAApFc2Nyb3dEYXRhAAAAAAAD",
        "AAAAAAAAADxSZWFkLW9ubHkgc3RhdHVzIHF1ZXJ5LiBFcnJvcnMgaWYgYGVzY3Jvd19pZGAgZG9lc24ndCBleGlzdC4AAAAKZ2V0X3N0YXR1cwAAAAAAAQAAAAAAAAAJZXNjcm93X2lkAAAAAAAABgAAAAEAAAPpAAAH0AAAAAxFc2Nyb3dTdGF0dXMAAAAD",
        "AAAAAAAAAc9Mb2NrcyBgYW1vdW50YCBvZiBgdG9rZW5gIHB1bGxlZCBmcm9tIGBwYXllcmAsIGhlbGQgZm9yIGBwYXllZWAsCnRhZ2dlZCB3aXRoIGFuIG9wYXF1ZSBgY29uZGl0aW9uX3JlZmAuIGByZWxlYXNlcmAgaXMgdGhlIG9ubHkKYWRkcmVzcyB0aGF0IHdpbGwgbGF0ZXIgYmUgcGVybWl0dGVkIHRvIGNhbGwgYHJlbGVhc2VgL2ByZWZ1bmRgCm9uIHRoaXMgZXNjcm93IChzZWUgZG9jcy9hZHIvMDAwMikuIGByZWZ1bmRfYWZ0ZXJgIGlzIGFuIG9wdGlvbmFsCnVuaXggdGltZXN0YW1wIGFmdGVyIHdoaWNoIGByZWZ1bmRgIG9wZW5zIHRvIGFueSBjYWxsZXIsIGFsd2F5cwpiYWNrIHRvIGBwYXllcmAgKGRvY3MvYWRyLzAwMDQpOyBgTm9uZWAgbWVhbnMgbm8gdGltZW91dC4KUmVxdWlyZXMgYHBheWVyYCBhdXRoICh0aGUgY29udHJhY3QgbW92ZXMgdGhlaXIgZnVuZHMpLiBSZXR1cm5zCnRoZSBuZXcgZXNjcm93J3MgaWQuAAAAAA1jcmVhdGVfZXNjcm93AAAAAAAABwAAAAAAAAAFcGF5ZXIAAAAAAAATAAAAAAAAAAVwYXllZQAAAAAAABMAAAAAAAAABXRva2VuAAAAAAAAEwAAAAAAAAAGYW1vdW50AAAAAAALAAAAAAAAAA1jb25kaXRpb25fcmVmAAAAAAAAEAAAAAAAAAAIcmVsZWFzZXIAAAATAAAAAAAAAAxyZWZ1bmRfYWZ0ZXIAAAPoAAAABgAAAAEAAAPpAAAABgAAAAM=" ]),
      options
    )
  }
  public readonly fromJSON = {
    refund: this.txFromJSON<Result<void>>,
        release: this.txFromJSON<Result<void>>,
        get_escrow: this.txFromJSON<Result<EscrowData>>,
        get_status: this.txFromJSON<Result<EscrowStatus>>,
        create_escrow: this.txFromJSON<Result<u64>>
  }
}