// Internal helpers shared by the SDK modules. Not re-exported from index.ts:
// nothing here is public API.
import { Address, scValToNative, xdr } from "@stellar/stellar-sdk";
import { ContractError, contractErrorName, toEscrowError } from "./errors.js";
import { type EscrowSpanAttributes } from "./instrumentation.js";
import { EscrowPreconditionError, type LifecycleCall, type LifecycleMethod } from "./lifecycle.js";
import { type Milestone, type MilestoneEscrow } from "./milestones.js";
import { type EscrowEvent, type EscrowLifecycleEventType } from "./events.js";

export function safeScValToNative(value: xdr.ScVal): unknown {
  try { return scValToNative(value); }
  catch { return { xdr: value.toXDR("base64") }; }
}

export function isRetentionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /cursor.{0,40}(older|retention|oldest)|older.{0,40}(cursor|ledger|retention)|start ledger.{0,40}(oldest|retention)/i.test(message);
}

/** The tranche at `milestoneIndex`, with a clear error outside the schedule. */
export function trancheOf(escrow: MilestoneEscrow, milestoneIndex: number): Milestone {
  if (!Number.isInteger(milestoneIndex) || milestoneIndex < 0 || milestoneIndex >= escrow.milestones.length) {
    throw new RangeError(
      `milestoneIndex ${milestoneIndex} is outside the schedule (0-${escrow.milestones.length - 1})`,
    );
  }
  return escrow.milestones[milestoneIndex];
}

export const TESTNET_RPC_URL = "https://soroban-testnet.stellar.org";
export const TESTNET_NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

/** The host's report that a deployment has no such function: not a transient failure. */
export const MISSING_FUNCTION_ERROR = /non-?existent contract function|Error\(WasmVm, MissingValue\)/i;

export function batchErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Shared placeholder used on the uninstrumented path (no per-call allocation). */
export const EMPTY_SPAN_ATTRIBUTES = {} as EscrowSpanAttributes;

/** Decode a contract address out of an `xdr.ScAddress`, or `undefined` for account addresses. */
export function contractAddressOf(scAddress: xdr.ScAddress): string | undefined {
  if (scAddress.switch().name !== "scAddressTypeContract") return undefined;
  return Address.fromScAddress(scAddress).toString();
}

export function assertPositiveAmount(call: { method: LifecycleMethod; amount: bigint }): void {
  if (call.amount <= 0n) {
    throw new EscrowPreconditionError(call.method, "InvalidAmount", `amount must be positive, got ${call.amount}.`);
  }
}

/** The party whose signature a lifecycle call needs. */
export function lifecycleCallSigner(call: LifecycleCall): string {
  if (call.method === "accept") return call.payee;
  if (call.method === "transfer_payee") return call.currentPayee;
  return call.payer;
}

/** The rejection value for an aborted wait: the signal's reason, or a standard `AbortError`. */
export function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("This operation was aborted", "AbortError");
}

/** Throws unless `value` is a positive whole number of ledgers. */
export function assertLedgerWindow(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive whole number of ledgers.`);
  }
}

/** The `TransactionResultCode` name from a rejected `sendTransaction`, if decodable. */
export function sendErrorName(sent: { errorResult?: unknown }): string | undefined {
  try {
    const result = (sent.errorResult as xdr.TransactionResult | undefined)?.result();
    return result?.switch().name;
  } catch {
    return undefined;
  }
}

/** Largest `u64`, the contract's timestamp/duration type. */
export const U64_MAX = (1n << 64n) - 1n;
/** Largest `u32`, the contract's period-count type. */
export const U32_MAX = 0xffff_ffff;

const utf8 = new TextEncoder();

/**
 * Length of `value` in UTF-8 bytes, which is what the contract's
 * `condition_ref.len()` counts (Soroban `String` is bytes, not UTF-16 units).
 */
export function utf8ByteLength(value: string): number {
  return utf8.encode(value).length;
}

/**
 * True when `error` is the contract error `name`. Matches the normalized
 * `ContractError.code`, or the bare variant name the generated client's
 * `Result.unwrap()` throws (its message carries the name but no code).
 */
export function isContractError(error: unknown, name: string): boolean {
  const normalized = toEscrowError(error);
  if (normalized instanceof ContractError && contractErrorName(normalized.code) === name) return true;
  const message = error instanceof Error ? error.message : String(error);
  return new RegExp(`(^|\\W)${name}(\\W|$)`).test(message);
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** The typed fields of a non-lifecycle {@link EscrowEvent}, without the RPC envelope. */
export type DecodedEventFields = DistributiveOmit<
  Exclude<EscrowEvent, { type: EscrowLifecycleEventType | "unknown" }>,
  "ledger" | "cursor" | "transactionHash" | "data"
>;

const asBigInt = (v: unknown): bigint | undefined =>
  typeof v === "bigint" ? v : typeof v === "number" && Number.isSafeInteger(v) ? BigInt(v) : undefined;
const asAddress = (v: unknown): string | undefined =>
  typeof v === "string" && /^[GC][A-Z2-7]{55}$/.test(v) ? v : undefined;
const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
function allDefined<T extends Record<string, unknown>>(fields: T): { [K in keyof T]: Exclude<T[K], undefined> } | undefined {
  return Object.values(fields).every((v) => v !== undefined) ? (fields as { [K in keyof T]: Exclude<T[K], undefined> }) : undefined;
}

/**
 * Decodes the contract's non-lifecycle events from native topics and data,
 * using the shapes the contract publishes (see `contracts/escrow/src/`).
 * Returns `undefined` for an unrecognised name or a payload of the wrong
 * shape, so the caller can fall back to an `unknown` event.
 */
export function decodeNonLifecycleEvent(topics: unknown[], data: unknown): DecodedEventFields | undefined {
  const [name, t1, t2, t3] = topics;
  const tuple = Array.isArray(data) ? data : [];
  const map = asRecord(data) ?? {};
  const escrowId = asBigInt(t1);
  let fields: DecodedEventFields | undefined;
  switch (name) {
    case "top_up": {
      const f = allDefined({ escrowId, amount: asBigInt(tuple[0]), newAmount: asBigInt(tuple[1]) });
      fields = f && { type: "topUp", ...f };
      break;
    }
    case "accepted": {
      const f = allDefined({ escrowId, payee: asAddress(tuple[0]), acceptedAt: asBigInt(tuple[1]) });
      fields = f && { type: "accepted", ...f };
      break;
    }
    case "rotate": {
      const f = allDefined({ escrowId, oldReleaser: asAddress(tuple[0]), newReleaser: asAddress(tuple[1]) });
      fields = f && { type: "rotated", ...f };
      break;
    }
    case "pay_xfer": {
      const f = allDefined({ escrowId, oldPayee: asAddress(tuple[0]), newPayee: asAddress(tuple[1]) });
      fields = f && { type: "payeeTransferred", ...f };
      break;
    }
    case "contrib": {
      const f = allDefined({ escrowId, contributor: asAddress(tuple[0]), amount: asBigInt(tuple[1]), funded: asBigInt(tuple[2]) });
      fields = f && { type: "contributed", ...f };
      break;
    }
    case "claimed": {
      const f = allDefined({ escrowId, contributor: asAddress(tuple[0]), amount: asBigInt(tuple[1]) });
      fields = f && { type: "claimed", ...f };
      break;
    }
    case "settled": {
      const f = allDefined({ escrowId, payeeAmount: asBigInt(tuple[0]), payerAmount: asBigInt(tuple[1]) });
      fields = f && { type: "settled", ...f };
      break;
    }
    case "payee_refunded": {
      const f = allDefined({ escrowId, payer: asAddress(t2), payee: asAddress(t3), amount: asBigInt(map.amount) });
      fields = f && { type: "payeeRefunded", ...f };
      break;
    }
    case "refund_deadline_extended": {
      const f = allDefined({ escrowId, oldDeadline: asBigInt(map.old_deadline), newDeadline: asBigInt(map.new_deadline) });
      fields = f && { type: "refundDeadlineExtended", ...f };
      break;
    }
    case "paused":
    case "unpaused": {
      const admin = asAddress(t1);
      fields = admin === undefined ? undefined : { type: name, admin };
      break;
    }
  }
  return fields;
}
