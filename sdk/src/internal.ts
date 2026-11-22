// Internal helpers shared by the SDK modules. Not re-exported from index.ts:
// nothing here is public API.
import { Address, scValToNative, xdr } from "@stellar/stellar-sdk";
import { type EscrowSpanAttributes } from "./instrumentation.js";
import { EscrowPreconditionError, type LifecycleCall, type LifecycleMethod } from "./lifecycle.js";
import { type Milestone, type MilestoneEscrow } from "./milestones.js";

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
