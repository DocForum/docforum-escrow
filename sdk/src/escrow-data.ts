import { scValToNative, xdr } from "@stellar/stellar-sdk";
import type { Escrow, EscrowStatus, SplitRecipient } from "./index.js";

const ESCROW_STATUSES: ReadonlySet<string> = new Set<EscrowStatus>([
  "Funded",
  "Released",
  "Refunded",
  "Cancelled",
]);

function fail(field: string, expected: string, value: unknown): never {
  throw new TypeError(`get_escrow returned ${field} as ${typeof value}, expected ${expected}.`);
}

function asString(value: unknown, field: string): string {
  return typeof value === "string" ? value : fail(field, "a string", value);
}

function asBigInt(value: unknown, field: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  return fail(field, "an integer", value);
}

function asOptionalBigInt(value: unknown, field: string): bigint | undefined {
  return value === undefined || value === null ? undefined : asBigInt(value, field);
}

function asNumber(value: unknown, field: string): number {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : fail(field, "an integer", value);
}

function asBoolean(value: unknown, field: string): boolean {
  return typeof value === "boolean" ? value : fail(field, "a boolean", value);
}

function asStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) return fail(field, "an array", value);
  return value.map((entry, index) => asString(entry, `${field}[${index}]`));
}

/** Split payouts, or an empty list on a deployment that predates them. */
function asSplits(value: unknown): SplitRecipient[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return fail("splits", "an array", value);
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      return fail(`splits[${index}]`, "a split record", entry);
    }
    const record = entry as Record<string, unknown>;
    return {
      address: asString(record.address, `splits[${index}].address`),
      bps: asNumber(record.bps, `splits[${index}].bps`),
    };
  });
}

function asStatus(value: unknown): EscrowStatus {
  // `scValToNative` represents a unit enum variant as a one-element array
  // (`["Funded"]`). The generated bindings use `{ tag: "Funded" }`, so accept
  // both shapes in case the representation changes.
  const candidate = Array.isArray(value)
    ? value[0]
    : value && typeof value === "object" && "tag" in value
      ? (value as { tag: unknown }).tag
      : value;
  if (typeof candidate === "string" && ESCROW_STATUSES.has(candidate)) {
    return candidate as EscrowStatus;
  }
  return fail("status", "a known escrow status", candidate);
}

/**
 * Decodes a raw `get_escrow` return value by field name.
 *
 * `EscrowData` is a Soroban map, so this works regardless of whether the
 * deployed contract has the newest field set. It exists because the generated
 * bindings decode structs positionally against the current spec; a deployment
 * that predates an added field would otherwise mis-align later fields and
 * throw.
 */
export function decodeEscrowDataFromScVal(value: xdr.ScVal): Escrow {
  const native = scValToNative(value);
  if (!native || typeof native !== "object" || Array.isArray(native)) {
    throw new TypeError("get_escrow did not return an escrow record.");
  }
  const record = native as Record<string, unknown>;

  return {
    payer: asString(record.payer, "payer"),
    payee: asString(record.payee, "payee"),
    token: asString(record.token, "token"),
    amount: asBigInt(record.amount, "amount"),
    conditionRef: asString(record.condition_ref, "condition_ref"),
    releasers: asStringArray(record.releasers, "releasers"),
    threshold: asNumber(record.threshold, "threshold"),
    refundAfter: asOptionalBigInt(record.refund_after, "refund_after"),
    releaseNotBefore: asOptionalBigInt(record.release_not_before, "release_not_before"),
    notifyPayee: asBoolean(record.notify_payee, "notify_payee"),
    refundTo: asString(record.refund_to, "refund_to"),
    // Pre-E6 deployments predate splits and the protocol fee: default them so
    // reads keep working across contract versions (issue #224 pattern).
    splits: asSplits(record.splits),
    feeBps: record.fee_bps === undefined ? 0 : asNumber(record.fee_bps, "fee_bps"),
    feeRecipient: record.fee_recipient === undefined
      ? asString(record.payer, "payer")
      : asString(record.fee_recipient, "fee_recipient"),
    status: asStatus(record.status),
  };
}
