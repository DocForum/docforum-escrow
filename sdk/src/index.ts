// @docforum/escrow-sdk — ergonomic wrapper around the generated Soroban
// contract client (src/generated/contract-client.ts). Consumers (e.g.
// docforum-core's `payments` module — see its ARCHITECTURE.md ADR 0002)
// should import from here, not from src/generated/ directly.
//
// No PHI, no healthcare concepts here (hard rule 1) — types stay generic
// (payer/payee/amount, not e.g. "patient"). Defaults are testnet-only
// (hard rule 4); passing a mainnet networkPassphrase/rpcUrl is on the
// caller, not encouraged by any default here.
import {
  Address,
  BASE_FEE,
  FeeBumpTransaction,
  Keypair,
  Operation,
  Networks,
  Transaction,
  TransactionBuilder,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { Api, Server as RpcServer } from "@stellar/stellar-sdk/rpc";
import type { AssembledTransaction, Result, SentTransaction } from "@stellar/stellar-sdk/contract";
import {
  Client as EscrowContractClient,
  type EscrowData as GeneratedEscrowData,
  type EscrowStatus as GeneratedEscrowStatus,
  type PooledData as GeneratedPooledData,
  type Contribution as GeneratedContribution,
} from "./generated/contract-client.js";
import { decodeEscrowDataFromScVal } from "./escrow-data.js";
import {
  beginPhase,
  isInstrumentationEnabled,
  tracePhase,
  type EscrowSpanAttributes,
  type InstrumentationOptions,
} from "./instrumentation.js";
import type { FactoryClient as FactoryClientType } from "./factory.js";
import { signerAddress, type EscrowSigner } from "./signers/types.js";
import { getTokenInfo as readTokenInfo, rpcTokenInfoSource, type TokenInfo } from "./amounts.js";

export { Keypair };
export {
  getTokenInfo,
  parseAmount,
  formatAmount,
  normaliseAmount,
  clearTokenInfoCache,
  rpcTokenInfoSource,
  AmountError,
  InvalidAmountError,
  MAX_TOKEN_DECIMALS,
  type TokenInfo,
  type TokenInfoSource,
  type TokenInfoSourceOptions,
} from "./amounts.js";
export { signerAddress, type EscrowSigner } from "./signers/types.js";
export {
  otelTracer,
  spanName,
  type EscrowInstrumentationEvent,
  type EscrowSpan,
  type EscrowSpanAttributes,
  type EscrowSpanName,
  type EscrowTracer,
  type InstrumentationOptions,
} from "./instrumentation.js";
export { EscrowIndexerClient } from "./indexer-client.js";
export type { EscrowIndexerClientConfig, EscrowPage, IndexedEscrow } from "./indexer-client.js";
export { FactoryClient, predictInstanceAddress } from "./factory.js";
export {
  KNOWN_DEPLOYMENTS,
  UnknownDeploymentError,
  knownContractId,
  knownNetworkConfig,
  latestDeployment,
  parseDeployments,
  type DeploymentRecord,
  type DeploymentVerificationCase,
  type DeploymentsDocument,
} from "./deployments.js";
export type { FactoryClientConfig, DeployInstanceParams, DeployInstanceResult, FactoryInstance } from "./factory.js";

// Multisig releaser account helpers (T1 mitigation). Client-side only: they
// build classic `setOptions` transactions for the releaser account itself and
// never touch the escrow contract.
export {
  buildMultisigSetup,
  dryRunMultisigSetup,
  printMultisigDryRun,
  readOnChainMultisig,
  resolveMultisigPolicy,
  validateMultisigPolicy,
  verifyMultisig,
  MultisigLockOutError,
  MultisigValidationError,
  MAX_WEIGHT,
  MIN_WEIGHT,
  TESTNET_PASSPHRASE,
} from "./multisig.js";
export type {
  BuildMultisigSetupOptions,
  HorizonServerLike,
  MultisigDryRun,
  MultisigOnState,
  MultisigPolicy,
  MultisigSetupResult,
  MultisigSigner,
  MultisigVerificationResult,
  ResolvedMultisigPolicy,
  VerifyMultisigOptions,
} from "./multisig.js";

export type EscrowStatus = "Funded" | "Released" | "Refunded" | "Cancelled";

/**
 * One tranche of a milestone schedule. A milestone escrow is a *group* of
 * single-tranche escrows — see `createMilestoneEscrow`.
 */
export type MilestoneStatus = "unreleased" | "released" | "refunded";

/** A single tranche of a milestone escrow. */
export interface Milestone {
  /** Position in the schedule, `0`-based — pass this to `releaseMilestone`. */
  index: number;
  /** Tranche amount in the token's smallest unit. */
  amount: bigint;
  /** The escrow that holds this tranche — see `createMilestoneEscrow`. */
  escrowId: bigint;
  status: MilestoneStatus;
}

export type ArchivedEntryBehavior = "auto" | "error";

/** Typed error for contract calls that cannot restore archived ledger entries. */
export class ArchivedEntryError extends Error {
  readonly method: string;
  override readonly cause?: unknown;
  constructor(method: string, behavior: ArchivedEntryBehavior, cause?: unknown) {
    super(behavior === "auto"
      ? `Contract state needed by ${method} is archived and automatic restoration failed. Ensure the configured signer can pay the restoration fee.`
      : `Contract state needed by ${method} is archived. Set archivalBehavior to "auto" and provide a restore signer to restore it.`);
    this.name = "ArchivedEntryError";
    this.method = method;
    this.cause = cause;
  }
}

export function isArchivedEntryFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; message?: unknown };
  return candidate.name === "ExpiredState" ||
    (typeof candidate.message === "string" && /expired state|archived (?:contract )?state|automatic restoration attempt limit reached/i.test(candidate.message));
}

export type EscrowEventType = "created" | "released" | "refunded" | "cancelled";
interface EscrowEventBase {
  ledger: number;
  cursor: string;
  transactionHash: string;
  data: unknown;
}
/**
 * Unknown variants are retained with decoded topics so newer contract event
 * schemas remain observable to older SDK consumers instead of crashing.
 */
export type EscrowEvent = (EscrowEventBase & {
  type: EscrowEventType;
  escrowId: bigint;
}) | (EscrowEventBase & {
  type: "unknown";
  eventName?: string;
  escrowId?: bigint;
  topics: unknown[];
});
export type GetEventsParams = {
  types?: EscrowEventType[];
  escrowId?: bigint;
} & (
  | { /** First ledger to scan (inclusive). */ fromLedger: number; cursor?: never }
  | { /** Opaque RPC cursor returned from a prior page/event. */ cursor: string; fromLedger?: never }
);
export interface GetEventsResult { events: EscrowEvent[]; nextCursor: string; }

/** The requested cursor predates the event history retained by the RPC server. */
export class EventCursorExpiredError extends Error {
  readonly name = "EventCursorExpiredError";
  constructor(message = "The event cursor is older than the RPC server's retention window.") { super(message); }
}

export interface SubscribeOptions {
  cursor?: string;
  pollIntervalMs?: number;
  types?: EscrowEventType[];
  escrowId?: bigint;
  onError?: (error: unknown) => void;
}

function safeScValToNative(value: xdr.ScVal): unknown {
  try { return scValToNative(value); }
  catch { return { xdr: value.toXDR("base64") }; }
}

function isRetentionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /cursor.{0,40}(older|retention|oldest)|older.{0,40}(cursor|ledger|retention)|start ledger.{0,40}(oldest|retention)/i.test(message);
}

/** Everything the contract stores about one escrow — what `getEscrow` returns. */
export interface Escrow {
  payer: string;
  payee: string;
  token: string;
  amount: bigint;
  conditionRef: string;
  /**
   * The addresses permitted to settle this escrow (docs/adr/0002 for the
   * per-escrow releaser, docs/adr/0007 for M-of-N sets) — unless
   * `refundAfter` has passed, in which case anyone may refund. A plain
   * single-releaser escrow has exactly one entry here.
   */
  releasers: string[];
  /**
   * How many distinct addresses from `releasers` must authorize one
   * settlement. `1` means any single releaser can settle.
   */
  threshold: number;
  /**
   * Optional deadline in unix seconds after which **anyone** may refund —
   * always back to `payer` (docs/adr/0004). `undefined` means no timeout:
   * refunds stay releaser-only forever. Payees should check this before
   * relying on a `Funded` escrow (threat model T8).
   */
  refundAfter?: bigint;
  /** Earliest ledger timestamp at which release is allowed. Omit for immediate release. */
  releaseNotBefore?: bigint;
  /**
   * Optional protocol-fee recipient, fixed at creation (docs/adr/0010).
   * Set together with `feeBps`; at release `feeBps` basis points of the
   * escrowed amount go here and the remainder to the payee. Refunds never
   * take a fee. `undefined` means no fee.
   */
  feeRecipient?: string;
  /**
   * Optional protocol-fee rate in basis points of the escrowed amount,
   * capped at 1 000 (10 %) and floored at release (docs/adr/0010). Must be
   * set together with `feeRecipient`.
   */
  feeBps?: number;
  /** Whether to call the contract payee's on_escrow_released hook. Defaults to false. */
  notifyPayee: boolean;
  /**
   * Where every refund (releaser or timeout) sends the funds. Fixed at
   * creation; equals `payer` unless a sponsored escrow set a different
   * destination (docs/adr/0009). Payees can read it to see who a
   * reversal would pay.
   */
  refundTo: string;
  /** Whether release waits for the payee's `accept` (issue #25). */
  requiresAcceptance: boolean;
  /** Ledger timestamp of the payee's acceptance; `undefined` until `accept`. */
  acceptedAt?: bigint;
  status: EscrowStatus;
}

/** Largest value an `i128` can hold — the contract's arithmetic type. */
const I128_MAX = 2n ** 127n - 1n;

/**
 * `condition_ref` is capped on-chain at `MAX_CONDITION_REF_LENGTH` bytes
 * (`contracts/escrow/src/lib.rs` `MAX_CONDITION_REF_LEN`, threat model T10);
 * a longer value is rejected with `ConditionRefTooLong`. A milestone group
 * tags each tranche, so the base ref has that much less room.
 */

/**
 * Thrown when a milestone schedule is invalid. Caught before any network
 * call, so an obviously-invalid schedule costs nothing.
 */
export class MilestoneScheduleError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`Invalid milestone schedule: ${reason}`);
    this.name = "MilestoneScheduleError";
    this.reason = reason;
  }
}

/**
 * Maximum protocol-fee rate in basis points of the escrowed amount — must
 * match the contract's `MAX_FEE_BPS` (1 000 = 10 %, see docs/adr/0010).
 * Validated client-side so callers fail fast instead of paying network
 * fees for a rejected transaction. Keep in sync with the contract; a
 * change is an SDK semver event (hard rule 3).
 */
export const MAX_FEE_BPS = 1_000;

/**
 * `amount` must be positive, the schedule non-empty, every tranche positive,
 * the sum exactly `amount`, and every value representable as an `i128`.
 * Pure and synchronous: a malformed schedule is a programmer error, not a
 * transaction to pay for.
 */
export function validateMilestoneSchedule(milestones: readonly bigint[], amount: bigint): void {
  if (amount <= 0n) throw new MilestoneScheduleError(`amount must be positive, got ${amount}`);
  if (milestones.length === 0) throw new MilestoneScheduleError("schedule must not be empty");
  let sum = 0n;
  for (const [index, tranche] of milestones.entries()) {
    if (tranche <= 0n) throw new MilestoneScheduleError(`tranche ${index} must be positive, got ${tranche}`);
    if (tranche > I128_MAX) throw new MilestoneScheduleError(`tranche ${index} exceeds the i128 maximum`);
    sum += tranche;
    if (sum > I128_MAX) throw new MilestoneScheduleError("schedule total exceeds the i128 maximum");
  }
  if (sum !== amount) {
    throw new MilestoneScheduleError(`schedule sums to ${sum} but amount is ${amount}`);
  }
}

/**
 * `condition_ref` for tranche `index` of `count`: `<base>#m<index+1>/<count>`.
 * Tagged so each tranche stays traceable back to its group on-chain, where
 * only the ref is visible.
 */
export function milestoneConditionRef(base: string, index: number, count: number): string {
  const ref = `${base}#m${index + 1}/${count}`;
  if (ref.length > MAX_CONDITION_REF_LENGTH) {
    throw new MilestoneScheduleError(
      `conditionRef "${base}" is too long: the tranche tag needs "${ref}" (${ref.length} bytes) but the contract allows ${MAX_CONDITION_REF_LENGTH}`,
    );
  }
  return ref;
}

/**
 * Thrown when `createMilestoneEscrow` fails partway through: a group is N
 * separate transactions, so the tranches before the failure are already
 * funded on-chain and must be dealt with by the caller.
 */
export class MilestoneEscrowPartialError extends Error {
  /** Escrow ids of the tranches that were created, in schedule order. */
  readonly createdEscrowIds: readonly bigint[];
  /** How many tranches had been created when the failure happened. */
  readonly createdCount: number;
  /** Total tranches the schedule asked for. */
  readonly totalCount: number;
  override readonly cause?: unknown;

  constructor(createdEscrowIds: readonly bigint[], createdCount: number, totalCount: number, cause?: unknown) {
    super(
      `Milestone escrow creation failed at tranche ${createdCount + 1} of ${totalCount}; ` +
        `${createdCount} tranche escrow(s) already exist and are funded: [${createdEscrowIds.join(", ")}]. ` +
        "Release or refund them, then retry the remaining tranches.",
    );
    this.name = "MilestoneEscrowPartialError";
    this.createdEscrowIds = createdEscrowIds;
    this.createdCount = createdCount;
    this.totalCount = totalCount;
    this.cause = cause;
  }
}

/** The tranche at `milestoneIndex`, with a clear error outside the schedule. */
function trancheOf(escrow: MilestoneEscrow, milestoneIndex: number): Milestone {
  if (!Number.isInteger(milestoneIndex) || milestoneIndex < 0 || milestoneIndex >= escrow.milestones.length) {
    throw new RangeError(
      `milestoneIndex ${milestoneIndex} is outside the schedule (0-${escrow.milestones.length - 1})`,
    );
  }
  return escrow.milestones[milestoneIndex];
}

const TESTNET_RPC_URL = "https://soroban-testnet.stellar.org";
const TESTNET_NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

/**
 * Named network presets (Phase E6). Each preset bundles the RPC URL, the
 * network passphrase and the known contract ids for that network. Hard rule
 * 4: testnet only until the security review — mainnet is deliberately not a
 * preset, and constructing a client against the mainnet passphrase throws
 * unless the caller passes `allowMainnet: true`.
 */
export interface NetworkPreset {
  /** Human-readable network name. */
  name: string;
  /** Soroban RPC endpoint for this network. */
  rpcUrl: string;
  /** Stellar network passphrase. */
  networkPassphrase: string;
  /** Known docforum-escrow contract ids deployed on this network. */
  contractIds: Record<string, string>;
  /** Plain-HTTP RPC is allowed (local quickstart only). Defaults to `false`. */
  allowHttp?: boolean;
}

/** The Stellar mainnet passphrase — never a default, only an explicit opt-in. */
export const MAINNET_NETWORK_PASSPHRASE = Networks.PUBLIC;

export const networks = {
  /** Soroban testnet — the only network wired into defaults (hard rule 4). */
  testnet: {
    name: "testnet",
    rpcUrl: TESTNET_RPC_URL,
    networkPassphrase: TESTNET_NETWORK_PASSPHRASE,
    // Current upstream deployment (docs/testnet-deployments.md) and the
    // testnet native XLM Stellar Asset Contract on its token allowlist.
    contractIds: {
      escrow: "CAFI5QOTNLK5OIHEHGGQ7B22RN5IUOFGKKEID2OQCZSCJAQS4FLSS2DR",
      nativeXlm: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    },
  } as NetworkPreset,
  /** Stellar futurenet — an experimental testnet, still not mainnet. */
  futurenet: {
    name: "futurenet",
    rpcUrl: "https://rpc-futurenet.stellar.org",
    networkPassphrase: Networks.FUTURENET,
    contractIds: {},
  } as NetworkPreset,
  /** A local quickstart node (private network). */
  local: {
    name: "local",
    rpcUrl: "http://localhost:8000/soroban/rpc",
    networkPassphrase: "Standalone Network ; February 2017",
    contractIds: {},
    allowHttp: true,
  } as NetworkPreset,
} as const;

/** Thrown when a client is configured for mainnet without the explicit opt-in. */
export class MainnetNotAllowedError extends Error {
  readonly name = "MainnetNotAllowedError";
  constructor() {
    super(
      "Refusing to construct a client against the Stellar mainnet passphrase. " +
        "Hard rule 4 keeps mainnet out of defaults until the security review; " +
        "pass allowMainnet: true to opt in deliberately.",
    );
  }
}

/** Thrown when the RPC's reported network passphrase does not match the configured one. */
export class NetworkMismatchError extends Error {
  readonly name = "NetworkMismatchError";
  readonly expected: string;
  readonly actual: string;
  constructor(expected: string, actual: string) {
    super(`RPC network passphrase mismatch: expected "${expected}", got "${actual}".`);
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * Maximum allowed length of `conditionRef` in bytes — must match the
 * contract's bound (currently 64 bytes, see contracts/escrow/src/lib.rs
 * and docs/threat-model.md T10). Validated client-side so callers fail
 * fast instead of paying network fees for a rejected transaction.
 *
 * Keep in sync with the contract: if the contract bound changes, update
 * this constant and bump the SDK's semver (hard rule 3).
 */
export const MAX_CONDITION_REF_LENGTH = 64;

/**
 * Maximum number of addresses in one escrow's releaser set — must match the
 * contract's `MAX_RELEASERS` (currently 10, see docs/adr/0007). Validated
 * client-side so callers fail fast instead of paying network fees for a
 * rejected transaction. Keep in sync with the contract; a change is an SDK
 * semver event (hard rule 3).
 */
export const MAX_RELEASERS = 10;

/** Shared placeholder used on the uninstrumented path (no per-call allocation). */
const EMPTY_SPAN_ATTRIBUTES = {} as EscrowSpanAttributes;

export interface EscrowClientConfig {
  /** The deployed docforum-escrow contract's address (`C…`). */
  contractId: string;
  /** Default: Soroban testnet RPC. */
  rpcUrl?: string;
  /** Default: Stellar testnet passphrase. */
  networkPassphrase?: string;
  /**
   * Optional OpenTelemetry / event-hook instrumentation (issue #129). With no
   * tracer and no `onEvent` callback, calls take the uninstrumented path.
   */
  instrumentation?: InstrumentationOptions;
  /** Shorthand for `instrumentation.onEvent`. */
  onEvent?: InstrumentationOptions["onEvent"];
  /** Use the restore signer to authorize calls that automatically restore archived entries. */
  archivalBehavior?: ArchivedEntryBehavior;
  restoreSigner?: Keypair;
  /**
   * Named network preset (Phase E6). Supplies `rpcUrl` and `networkPassphrase`
   * defaults; explicit `rpcUrl`/`networkPassphrase` still win. Custom networks
   * (e.g. a private quickstart) can be configured without a preset.
   */
  network?: NetworkPreset;
  /**
   * Explicit opt-in required to construct a client against the Stellar
   * mainnet passphrase (hard rule 4). Defaults to `false`.
   */
  allowMainnet?: boolean;
  /**
   * Allow a plain-HTTP `rpcUrl` (e.g. a private quickstart node). Defaults to
   * the preset's `allowHttp` (only `networks.local` sets it), else `false`.
   */
  allowHttp?: boolean;
  /**
   * Verify the RPC's reported network passphrase against the configured one,
   * lazily and once, before the client's first network call, and throw
   * `NetworkMismatchError` on a mismatch. Never runs during construction.
   *
   * - `true`: always verify. An RPC that cannot report its network (no
   *   `getNetwork`) is an error, since verification was explicitly asked for.
   *   Recommended with a custom `rpcUrl`, so it cannot silently point the
   *   client at a different network (including mainnet) than its passphrase.
   * - `false`: never verify automatically (`verifyNetwork()` still works on
   *   demand).
   * - unset (default): verify only when a `network` preset is selected, and
   *   skip the check if the RPC has no `getNetwork` (e.g. an offline test
   *   double).
   *
   * The result is cached: one `getNetwork` round trip per client, not per
   * call. A failed check is not cached, so a transient RPC error is retryable.
   */
  verifyNetwork?: boolean;
}

export interface CreateEscrowParams {
  /** Signs and pays for this call; funds are pulled from this account. */
  payer: EscrowSigner;
  payee: string;
  token: string;
  amount: bigint;
  conditionRef: string;
  /**
   * The only address later permitted to call `release`/`refund` on this
   * escrow (see docforum-escrow's docs/adr/0002). Typically the calling
   * application's own service identity, not the payer or payee.
   */
  releaser: string;
  /**
   * Optional unix timestamp (seconds) after which anyone may refund this
   * escrow — always back to `payer` (docs/adr/0004). Must be strictly in
   * the future at creation, or the contract rejects with
   * `InvalidRefundAfter` (error 5). Omit for no timeout: refunds stay
   * releaser-only, exactly as in 0.2.x.
   */
  refundAfter?: bigint;
  /** Opt a contract payee into on_escrow_released(escrowId, amount). Defaults to false. */
  notifyPayee?: boolean;
  /**
   * Optional refund destination distinct from `payer` (the funder), for
   * sponsored escrows (docs/adr/0009). All refund paths — releaser and
   * timeout — pay this address, never the funder. Set once here under the
   * funder's signature and immutable afterwards. Omit to refund the
   * `payer`, exactly as in 0.3.x. Must not be the contract's own address
   * (rejected with `InvalidRefundTo`, error 21).
   */
  refundTo?: string;
  /** Earliest ledger timestamp at which release is allowed; omit for immediate release. */
  releaseNotBefore?: bigint;
  /**
   * Optional protocol fee, fixed at creation and taken at release
   * (docs/adr/0010). `feeRecipient` and `feeBps` are one atomic pair: give
   * both or neither, and `feeBps` may not exceed 1 000 (10 %). Omit both
   * for no fee — the payee then receives the full amount, as before.
   */
  feeRecipient?: string;
  /** Fee rate in basis points of the escrowed amount; see `feeRecipient`. */
  feeBps?: number;
  /**
   * Require the payee to `accept` before release (issue #25). Until they
   * do, the payer may `cancel`. Cannot be combined with `notifyPayee` or
   * `releaseNotBefore` (the contract has no such creation entry point).
   */
  requiresAcceptance?: boolean;
}

export interface CreateMilestoneEscrowParams extends Omit<CreateEscrowParams, "amount"> {
  /** Total across all tranches; must equal the sum of `milestones`. */
  amount: bigint;
  /**
   * Tranche schedule in payout order. Every entry must be positive and the
   * entries must sum exactly to `amount`; validated before any transaction
   * (`MilestoneScheduleError`).
   */
  milestones: readonly bigint[];
}

/**
 * A milestone schedule, as returned by `createMilestoneEscrow`: one
 * single-tranche escrow per tranche, in schedule order.
 */
export interface MilestoneEscrow {
  milestones: Milestone[];
  /** The tranche escrow ids, in schedule order. */
  escrowIds: bigint[];
}

export interface CancelParams {
  escrowId: bigint;
  /** The escrow's payer; signs the cancellation. */
  payer: EscrowSigner;
  /** See `LifecycleCallOptions.checkPreconditions`. Default `true`. */
  checkPreconditions?: boolean;
}

// ---------------------------------------------------------------------------
// Lifecycle amendments (issue #84): top-up, payee acceptance, payer cancel,
// plus a prepare → collect auth → submit flow for calls signed by parties
// on different machines.
// ---------------------------------------------------------------------------

/** Options shared by the lifecycle amendment methods. */
export interface LifecycleCallOptions {
  /**
   * Read the escrow first and throw `EscrowPreconditionError` when the call
   * would certainly fail (wrong signer, not `Funded`, no acceptance gate,
   * already accepted). Costs one read-only simulation, saves a failed
   * transaction fee. The contract enforces the same rules either way.
   * Default `true`.
   */
  checkPreconditions?: boolean;
}

export interface TopUpParams extends LifecycleCallOptions {
  escrowId: bigint;
  /** The escrow's original payer; signs the transfer and pays the fee. */
  payer: EscrowSigner;
  /** Raw token units to add; must be positive. */
  amount: bigint;
}

export interface AcceptParams extends LifecycleCallOptions {
  escrowId: bigint;
  /** The escrow's payee; signs the acceptance and pays the fee. */
  payee: EscrowSigner;
}

/**
 * Why a lifecycle call was refused before submission. Each maps to the
 * contract error the transaction would otherwise fail with.
 */
export type EscrowPreconditionCode =
  | "InvalidAmount"
  | "NotFunded"
  | "Unauthorized"
  | "AcceptanceNotConfigured"
  | "AlreadyAccepted";

/** Thrown before any transaction is built when a client-side check fails. */
export class EscrowPreconditionError extends Error {
  readonly name = "EscrowPreconditionError";
  readonly code: EscrowPreconditionCode;
  readonly method: LifecycleMethod;
  constructor(method: LifecycleMethod, code: EscrowPreconditionCode, message: string) {
    super(`${method}: ${message}`);
    this.method = method;
    this.code = code;
  }
}

/** Contract functions the prepare/submit flow can carry. */
export type LifecycleMethod = "top_up" | "accept" | "cancel";

/** One lifecycle call, described without any signer. */
export type LifecycleCall =
  | { method: "top_up"; escrowId: bigint; payer: string; amount: bigint }
  | { method: "accept"; escrowId: bigint; payee: string }
  | { method: "cancel"; escrowId: bigint; payer: string };

/**
 * A simulated lifecycle transaction in transit between signers. Plain JSON
 * strings and numbers only, so it can be passed between processes or
 * machines as-is (for example over HTTP or a queue).
 */
export interface PreparedLifecycleCall {
  method: LifecycleMethod;
  /** `AssembledTransaction.toJSON()` output; not a base64 envelope. */
  transaction: string;
  /** The transaction source: signs the envelope and pays the fee at submit. */
  source: string;
  /** Addresses whose contract auth entry is still unsigned. */
  pendingSigners: string[];
  /** Ledger after which every collected auth entry expires. */
  expiresAtLedger: number;
}

export interface PrepareLifecycleParams extends LifecycleCallOptions {
  call: LifecycleCall;
  /**
   * Address that will submit the transaction (envelope signer and fee
   * payer). Its own auth is covered by the envelope signature, so it never
   * appears in `pendingSigners`. Defaults to the call's own signer.
   */
  source?: string;
  /** How long collected auth entries stay valid. Default `PREPARED_AUTH_TTL_LEDGERS`. */
  ttlLedgers?: number;
}

/** Default lifetime of auth entries collected by `prepareLifecycleCall`, in ledgers (~5 minutes). */
export const PREPARED_AUTH_TTL_LEDGERS = 60;

/**
 * Creation parameters for a pooled escrow (issue #113, docs/adr/0011): one
 * agreement funded by many payers. Creation funds nothing — `contribute`
 * does, before `fundingDeadline`, up to `fundingTarget`.
 */
export interface CreatePooledEscrowParams {
  /** Signs and pays for creation; funds nothing at this step. */
  creator: EscrowSigner;
  payee: string;
  token: string;
  /**
   * Raw token units the contributors must reach before `release` becomes
   * possible. Must be positive; fixed at creation, never changed.
   */
  fundingTarget: bigint;
  conditionRef: string;
  /** The address permitted to `release` the fully funded pool (docs/adr/0002). */
  releaser: string;
  /**
   * Unix seconds after which contributions are rejected forever and, if
   * the target was missed, `claimRefund` opens to every contributor.
   * Must be strictly in the future (contract error
   * `InvalidFundingDeadline`, 34).
   */
  fundingDeadline: bigint;
}

export interface ContributeParams {
  escrowId: bigint;
  /** Signs the transfer; the funds come from this account. */
  payer: EscrowSigner;
  /** Raw token units; positive, and only while the pool is under target. */
  amount: bigint;
}

/** Pull-based refund params — the contributor claims their own record. */
export interface ClaimRefundParams {
  escrowId: bigint;
  /** Must be the recorded contributor; signs the claim (docs/adr/0011). */
  contributor: EscrowSigner;
}

/** Read-only funding config of a pooled escrow (`getPooled`). */
export interface PooledEscrow {
  fundingTarget: bigint;
  fundingDeadline: bigint;
}

/**
 * Per-token solvency reading (`getSolvency`, issue #39). `liabilities` is
 * the on-chain sum of `amount` over every `Funded` escrow in that token.
 */
export interface SolvencyReport {
  /** The escrow contract's current balance of the token. */
  balance: bigint;
  /** Total the contract owes in that token across all `Funded` escrows. */
  liabilities: bigint;
  /** `balance >= liabilities`. */
  solvent: boolean;
}

/** One contributor's record on a pooled escrow (`getContribution`). */
export interface ContributionRecord {
  /** Total accepted contributions from this address — claimable if not `refunded`. */
  amount: bigint;
  /** True once `claimRefund` has paid this record; a second claim fails. */
  refunded: boolean;
}

export interface ReleaseOrRefundParams {
  escrowId: bigint;
  /**
   * Must be one of the escrow's `releasers` (set at creation) — see
   * docs/adr/0002. Only valid when the escrow's threshold is `1`; a
   * multi-signature escrow settles via `releaseWithApprovals` /
   * `refundWithApprovals`.
   */
  caller: EscrowSigner;
}

/** Release params for one tranche of a milestone escrow. */
export interface ReleaseMilestoneParams {
  /** The group returned by `createMilestoneEscrow`. */
  escrow: MilestoneEscrow;
  /** `0`-based position in the schedule. */
  milestoneIndex: number;
  /** Must be that tranche's `releaser` (set at creation) — see docs/adr/0002. */
  caller: EscrowSigner;
}

/** Refund params for one tranche of a milestone escrow — same rules as `refund`. */
export interface RefundMilestoneParams {
  escrow: MilestoneEscrow;
  milestoneIndex: number;
  caller: EscrowSigner;
}

/** Creation parameters for an M-of-N releaser escrow (docs/adr/0007). */
export interface CreateQuorumEscrowParams {
  /** Signs and pays for this call; funds are pulled from this account. */
  payer: EscrowSigner;
  payee: string;
  token: string;
  amount: bigint;
  conditionRef: string;
  /**
   * The addresses that settle this escrow. Between 1 and `MAX_RELEASERS`
   * distinct addresses, stored immutably at creation — there is no setter
   * and no admin.
   */
  releasers: string[];
  /** How many of `releasers` must approve a settlement (at least 1). */
  threshold: number;
  /** See `CreateEscrowParams.refundAfter`. */
  refundAfter?: bigint;
  /** Opt a contract payee into `on_escrow_released`; requires payee authorization. */
  notifyPayee?: boolean;
  /** Optional refund destination distinct from `payer` (docs/adr/0009); defaults to `payer`. */
  refundTo?: string;
}

/** An M-of-N settlement: each keypair signs the contract auth entry. */
export interface SettlementApprovalsParams {
  escrowId: bigint;
  /**
   * The releasers approving this settlement. The first keypair also pays the
   * transaction fee; each of them signs the contract authorization entry, so
   * the list must not repeat a keypair. Without at least `threshold`
   * distinct approvers the contract rejects the call with `ThresholdNotMet`.
   */
  approvers: EscrowSigner[];
}

/** The relayer pays the transaction fee; the releaser signs only contract auth. */
export interface RelayedAuthorizationParams {
  escrowId: bigint;
  releaser: Keypair;
  relayer: Keypair;
}

/**
 * Serialized, simulated transaction containing a short-lived signed auth
 * entry. `transaction` is the JSON form produced by the Stellar SDK's
 * `AssembledTransaction.toJSON()` (it carries the simulation metadata the
 * relayer needs to sign the envelope); it is not a base64 envelope.
 */
export interface RelayedAuthorization {
  transaction: string;
  expiresAtLedger: number;
}

/** How long a relayed auth entry stays valid, in ledgers. */
export const RELAYED_AUTH_TTL_LEDGERS = 10;

// ---------------------------------------------------------------------------
// Fee estimation + sponsorship (issue #70)
// ---------------------------------------------------------------------------

/** A single contract invocation to estimate the fee of. */
export interface EstimateCallParams {
  /** Contract to invoke. Defaults to the client's configured `contractId`. */
  contractId?: string;
  /** Contract function name, e.g. `"create_escrow"`. */
  method: string;
  /** Already-encoded contract arguments (`xdr.ScVal[]`). */
  args?: xdr.ScVal[];
  /** Account that would sign and pay for the call. */
  source: EscrowSigner;
}

/** Components of a simulated contract call's fee, in stroops. */
export interface FeeEstimate {
  /** Resource fee charged for CPU/memory/ledger entries, buffered for drift. */
  resourceFee: bigint;
  /** Inclusion fee: base fee × number of operations. */
  inclusionFee: bigint;
  /** `resourceFee + inclusionFee` — what the call is expected to cost. */
  total: bigint;
  /** The unbuffered resource fee the simulation reported. */
  minResourceFee: bigint;
}

export interface FeeBumpOptions {
  /**
   * Hard cap, in stroops, on the fee-bump transaction's fee. If the fee the
   * bump requires would exceed it, `feeBump` throws `MaxFeeExceededError`
   * instead of silently exceeding the cap.
   */
  maxFee: bigint;
  /** Base fee per operation for the wrapper, in stroops. Default: the network base fee (100). */
  baseFee?: bigint;
}

export interface FeeBumpResult {
  /** Signed fee-bump envelope, base64 XDR. */
  xdr: string;
  /** Fee the fee-bump transaction will charge, in stroops. */
  fee: bigint;
  /** Hash of the inner (sponsored) transaction — the one that actually executes. */
  innerTxHash: string;
}

/** Outcome of the sponsorship guard. */
export interface GuardResult {
  /** True only when every operation and contract-address auth entry targets the escrow contract. */
  ok: boolean;
  /** Human-readable rejection reasons, empty when `ok`. */
  reasons: string[];
  /** Every contract id the transaction invokes. */
  invokedContracts: string[];
}

/** Thrown when the sponsorship guard rejects a transaction. */
export class SponsorshipGuardError extends Error {
  readonly reasons: string[];
  constructor(reasons: string[]) {
    super(`Sponsorship guard rejected transaction: ${reasons.join("; ")}`);
    this.name = "SponsorshipGuardError";
    this.reasons = reasons;
  }
}

/** Thrown when a fee-bump would exceed the caller's `maxFee`. */
export class MaxFeeExceededError extends Error {
  readonly requestedFee: bigint;
  readonly maxFee: bigint;
  constructor(requestedFee: bigint, maxFee: bigint) {
    super(`Fee-bump requires ${requestedFee} stroops, above the maxFee cap of ${maxFee}`);
    this.name = "MaxFeeExceededError";
    this.requestedFee = requestedFee;
    this.maxFee = maxFee;
  }
}

/** Default headroom added to the simulated resource fee: 20% (2000 bps). */
export const DEFAULT_RESOURCE_FEE_BUFFER_BPS = 2_000;

/**
 * Pure fee arithmetic, split out so it can be unit-tested without an RPC.
 * The buffer is applied to the resource fee only (inclusion fee is already
 * deterministic) and rounds up, so an estimate is never a strop short.
 */
export function computeFeeEstimate(input: {
  minResourceFee: bigint;
  inclusionFee: bigint;
  bufferBps?: number;
}): FeeEstimate {
  const { minResourceFee, inclusionFee } = input;
  const bufferBps = input.bufferBps ?? DEFAULT_RESOURCE_FEE_BUFFER_BPS;
  if (minResourceFee < 0n) throw new RangeError("minResourceFee must not be negative.");
  if (inclusionFee < 0n) throw new RangeError("inclusionFee must not be negative.");
  if (!Number.isInteger(bufferBps) || bufferBps < 0) throw new RangeError("bufferBps must be a non-negative integer.");
  const resourceFee = (minResourceFee * BigInt(10_000 + bufferBps) + 9_999n) / 10_000n;
  return { resourceFee, inclusionFee, total: resourceFee + inclusionFee, minResourceFee };
}

/** Decode a contract address out of an `xdr.ScAddress`, or `undefined` for account addresses. */
function contractAddressOf(scAddress: xdr.ScAddress): string | undefined {
  if (scAddress.switch().name !== "scAddressTypeContract") return undefined;
  return Address.fromScAddress(scAddress).toString();
}

/**
 * Thin client for the docforum-escrow Soroban contract. Wraps
 * `create_escrow`/`get_status`/`get_escrow`/`release`/`refund` with plain
 * TypeScript types and no manual XDR/signing plumbing.
 */
function assertPositiveAmount(call: { method: LifecycleMethod; amount: bigint }): void {
  if (call.amount <= 0n) {
    throw new EscrowPreconditionError(call.method, "InvalidAmount", `amount must be positive, got ${call.amount}.`);
  }
}

/** The party whose signature a lifecycle call needs. */
function lifecycleCallSigner(call: LifecycleCall): string {
  return call.method === "accept" ? call.payee : call.payer;
}

export class EscrowClient {
  /** Contract id of the escrow instance this client talks to. */
  readonly contractId: string;
  private readonly rpcUrl: string;
  private readonly networkPassphrase: string;
  private readonly rpc: RpcServer;
  private readonly instrumentation?: InstrumentationOptions;
  private readonly archivalBehavior: ArchivedEntryBehavior;
  private readonly restoreSigner?: Keypair;
  private readonly allowMainnet: boolean;
  private readonly allowHttp: boolean;
  /** "required": explicit opt-in; "auto": preset selected; "off": no automatic check. */
  private readonly networkVerification: "required" | "auto" | "off";
  /** Cached result of the network passphrase verification. */
  private networkVerified?: Promise<void>;

  constructor(config: EscrowClientConfig) {
    this.contractId = config.contractId;
    this.rpcUrl = config.rpcUrl ?? config.network?.rpcUrl ?? TESTNET_RPC_URL;
    this.networkPassphrase =
      config.networkPassphrase ?? config.network?.networkPassphrase ?? TESTNET_NETWORK_PASSPHRASE;
    this.allowMainnet = config.allowMainnet === true;
    if (this.networkPassphrase === MAINNET_NETWORK_PASSPHRASE && !this.allowMainnet) {
      throw new MainnetNotAllowedError();
    }
    // No network I/O here: verification is lazy (see ensureNetworkVerified).
    this.networkVerification =
      config.verifyNetwork === true
        ? "required"
        : config.verifyNetwork === false
          ? "off"
          : config.network
            ? "auto"
            : "off";
    this.allowHttp = config.allowHttp ?? config.network?.allowHttp ?? false;
    this.rpc = new RpcServer(this.rpcUrl, { allowHttp: this.allowHttp });
    this.instrumentation = config.onEvent
      ? { ...config.instrumentation, onEvent: config.onEvent }
      : config.instrumentation;
    this.archivalBehavior = config.archivalBehavior ?? "error";
    this.restoreSigner = config.restoreSigner;
  }

  /**
   * Builds an `EscrowClient` for the instance owned by `integrator`, looked up
   * through `factoryClient`. Throws if the integrator has no deployed instance
   * yet — deploy one with `FactoryClient.deployInstance` first.
   */
  static async forIntegrator(
    factoryClient: FactoryClientType,
    integrator: string,
  ): Promise<EscrowClient> {
    const instance = await factoryClient.getInstance(integrator);
    if (!instance) {
      throw new Error(`No escrow instance is deployed for integrator ${integrator}.`);
    }
    return new EscrowClient({
      contractId: instance.contractId,
      rpcUrl: factoryClient.rpcUrl,
      networkPassphrase: factoryClient.networkPassphrase,
    });
  }

  /**
   * Verifies once (and caches) that the RPC's reported network passphrase
   * matches the configured one. A mismatch throws `NetworkMismatchError` so a
   * custom `rpcUrl` cannot silently point a client at another network. Calling
   * this is an explicit request, so an RPC without `getNetwork` is an error. A
   * rejection is not cached, so a transient RPC failure is retryable.
   */
  verifyNetwork(): Promise<void> {
    return this.runNetworkVerification(true);
  }

  private runNetworkVerification(required: boolean): Promise<void> {
    if (!this.networkVerified) {
      const rpc = this.rpc as Partial<Pick<RpcServer, "getNetwork">>;
      if (typeof rpc.getNetwork !== "function") {
        // Not cached: a later explicit request must still fail loudly.
        return required
          ? Promise.reject(
              new Error("Cannot verify the network: the RPC client does not implement getNetwork()."),
            )
          : Promise.resolve();
      }
      const getNetwork = rpc.getNetwork.bind(rpc);
      this.networkVerified = (async () => {
        const rpcNetwork = await getNetwork();
        if (rpcNetwork.passphrase !== this.networkPassphrase) {
          throw new NetworkMismatchError(this.networkPassphrase, rpcNetwork.passphrase);
        }
      })();
      this.networkVerified.catch(() => {
        this.networkVerified = undefined;
      });
    }
    return this.networkVerified;
  }

  /**
   * Gate on every network call path: lazily verifies the RPC's passphrase once
   * (see `verifyNetwork()`), then reuses the cached result. A no-op unless a
   * `network` preset was selected or `verifyNetwork: true` was passed; with a
   * preset only, an RPC without `getNetwork` is skipped rather than failing.
   */
  private async ensureNetworkVerified(): Promise<void> {
    if (this.networkVerification === "off") return;
    await this.runNetworkVerification(this.networkVerification === "required");
  }

  private contractClient(signer?: EscrowSigner): EscrowContractClient {
    const effectiveSigner = signer ?? (this.archivalBehavior === "auto" ? this.restoreSigner : undefined);
    return new EscrowContractClient({
      contractId: this.contractId,
      rpcUrl: this.rpcUrl,
      networkPassphrase: this.networkPassphrase,
      allowHttp: this.allowHttp,
      ...(effectiveSigner
        ? { publicKey: signerAddress(effectiveSigner), signTransaction: effectiveSigner }
        : {}),
    });
  }

  /** Non-secret attributes shared by every span of one contract call. */
  private spanAttributes(method: string, escrowId?: bigint, address?: string): EscrowSpanAttributes {
    const attributes: EscrowSpanAttributes = {
      "contract.id": this.contractId,
      "contract.function": method,
    };
    if (escrowId !== undefined) attributes["escrow.id"] = escrowId.toString();
    if (address && this.instrumentation?.includeAddresses) attributes["account.address"] = address;
    return attributes;
  }

  /** `spanAttributes` only when instrumentation is on; otherwise no allocation. */
  private spanAttributesIfEnabled(method: string, escrowId?: bigint, address?: string): EscrowSpanAttributes {
    return isInstrumentationEnabled(this.instrumentation)
      ? this.spanAttributes(method, escrowId, address)
      : EMPTY_SPAN_ATTRIBUTES;
  }

  /**
   * Simulate, sign, submit and confirm one write call, recording one span per
   * phase. With instrumentation disabled it skips every span allocation and
   * takes the shortest path (`send()`, which polls to completion).
   */
  private async invoke<T>(
    method: string,
    escrowId: bigint | undefined,
    build: () => Promise<AssembledTransaction<T>>,
    hooks: { beforeSign?: (tx: AssembledTransaction<T>) => Promise<void>; address?: string } = {},
  ): Promise<SentTransaction<T>> {
    await this.ensureNetworkVerified();
    const attributes = this.spanAttributesIfEnabled(method, escrowId, hooks.address);
    const tx = await tracePhase(this.instrumentation, "simulate", attributes, build);
    if (tx.isReadCall) {
      throw new Error(`${method} was simulated as a read call; no transaction was sent.`);
    }
    await tracePhase(this.instrumentation, "sign", attributes, async () => {
      if (hooks.beforeSign) await hooks.beforeSign(tx);
      await tx.sign();
    });

    if (!this.instrumentation?.tracer && !this.instrumentation?.onEvent) {
      return tx.send();
    }

    const submitSpan = beginPhase(this.instrumentation, "submit", attributes);
    const confirmSpan = beginPhase(this.instrumentation, "confirm", attributes);
    let submitted = false;
    try {
      // `send()` submits and polls to a terminal state. `onSubmitted` marks
      // the submit/confirm boundary so the two phases are timed separately.
      const sent = await tx.send({
        onSubmitted: (response?: Api.SendTransactionResponse) => {
          submitted = true;
          if (response?.hash) {
            submitSpan.attributes["tx.hash"] = response.hash;
            confirmSpan.attributes["tx.hash"] = response.hash;
          }
          submitSpan.end();
          confirmSpan.start();
        },
      });
      if (!submitted) {
        submitSpan.end();
        confirmSpan.start();
      }
      const hash = sent.sendTransactionResponse?.hash;
      if (hash) {
        submitSpan.attributes["tx.hash"] = hash;
        confirmSpan.attributes["tx.hash"] = hash;
      }
      const attempts = sent.getTransactionResponseAll?.length ?? 0;
      if (attempts > 0) confirmSpan.attributes["retry.count"] = Math.max(0, attempts - 1);
      confirmSpan.end();
      return sent;
    } catch (error) {
      if (!submitted) submitSpan.end(error);
      confirmSpan.end(error);
      throw error;
    }
  }

  /** Locks `amount` of `token` from `payer`, held for `payee`. Returns the new escrow's id and the funding transaction's hash. */
  async createEscrow(params: CreateEscrowParams): Promise<{ escrowId: bigint; txHash: string }> {
    if (params.conditionRef.length > MAX_CONDITION_REF_LENGTH) {
      throw new Error(
        `conditionRef must be at most ${MAX_CONDITION_REF_LENGTH} bytes, got ${params.conditionRef.length}`
      );
    }
    if ((params.feeRecipient === undefined) !== (params.feeBps === undefined)) {
      throw new TypeError("feeRecipient and feeBps must be given together, or both omitted");
    }
    if (params.feeBps !== undefined && (!Number.isInteger(params.feeBps) || params.feeBps < 0 || params.feeBps > MAX_FEE_BPS)) {
      throw new RangeError(`feeBps must be an integer between 0 and ${MAX_FEE_BPS} (10 %)`);
    }
    const client = this.contractClient(params.payer);
    const createParams = {
      payer: signerAddress(params.payer),
      payee: params.payee,
      token: params.token,
      amount: params.amount,
      condition_ref: params.conditionRef,
      releaser: params.releaser,
      refund_after: params.refundAfter,
      notify_payee: params.notifyPayee ?? false,
      refund_to: params.refundTo,
      fee_recipient: params.feeRecipient,
      fee_bps: params.feeBps,
    };
    if (params.requiresAcceptance && (params.notifyPayee || params.releaseNotBefore !== undefined)) {
      throw new Error("requiresAcceptance cannot be combined with notifyPayee or releaseNotBefore.");
    }
    const sent = await this.invoke(
      "create_escrow",
      undefined,
      () => params.requiresAcceptance
        ? client.create_escrow_with_acceptance({
            payer: createParams.payer,
            payee: createParams.payee,
            token: createParams.token,
            amount: createParams.amount,
            condition_ref: createParams.condition_ref,
            releaser: createParams.releaser,
            refund_after: createParams.refund_after,
            requires_acceptance: true,
            refund_to: createParams.refund_to,
          })
        : params.releaseNotBefore === undefined
        ? client.create_escrow(createParams)
        : client.create_escrow_release_time({
            ...createParams,
            release_not_before: params.releaseNotBefore,
          }),
      { address: signerAddress(params.payer) },
    );
    return { escrowId: sent.result.unwrap(), txHash: sent.sendTransactionResponse!.hash };
  }

  /**
   * Read-only: `decimals`, `symbol` and `name` for `token`, read from the
   * SEP-41 contract over this client's RPC and cached per contract address.
   * Pass the returned `decimals` to `parseAmount`/`formatAmount` instead of
   * assuming 7.
   */
  async getTokenInfo(token: string): Promise<TokenInfo> {
    await this.ensureNetworkVerified();
    return readTokenInfo(
      token,
      rpcTokenInfoSource({ rpcUrl: this.rpcUrl, networkPassphrase: this.networkPassphrase }),
    );
  }

  /** Read-only status query. Throws if `escrowId` doesn't exist. */
  async getStatus(escrowId: bigint): Promise<EscrowStatus> {
    await this.ensureNetworkVerified();
    const client = this.contractClient();
    const tx = await tracePhase(
      this.instrumentation,
      "simulate",
      this.spanAttributesIfEnabled("get_status", escrowId),
      () => client.get_status({ escrow_id: escrowId }),    );
    const status: GeneratedEscrowStatus = tx.result.unwrap();
    return status.tag;
  }

  /**
   * Locks `amount` on behalf of an M-of-N releaser set (docs/adr/0007): the
   * escrow settles only with `threshold` distinct approvals from
   * `releasers`. Same validation and returned shape as `createEscrow`.
   */
  async createQuorumEscrow(
    params: CreateQuorumEscrowParams
  ): Promise<{ escrowId: bigint; txHash: string }> {
    if (params.conditionRef.length > MAX_CONDITION_REF_LENGTH) {
      throw new Error(
        `conditionRef must be at most ${MAX_CONDITION_REF_LENGTH} bytes, got ${params.conditionRef.length}`
      );
    }
    if (params.releasers.length === 0) {
      throw new Error("releasers must contain at least one address");
    }
    if (params.releasers.length > MAX_RELEASERS) {
      throw new Error(
        `releasers must contain at most ${MAX_RELEASERS} addresses, got ${params.releasers.length}`
      );
    }
    if (new Set(params.releasers).size !== params.releasers.length) {
      throw new Error("releasers must not contain duplicate addresses");
    }
    if (
      !Number.isInteger(params.threshold) ||
      params.threshold < 1 ||
      params.threshold > params.releasers.length
    ) {
      throw new Error(
        `threshold must be an integer between 1 and ${params.releasers.length}, got ${params.threshold}`
      );
    }
    const client = this.contractClient(params.payer);
    const sent = await this.invoke(
      "create_escrow_with_releasers",
      undefined,
      () =>
        client.create_escrow_with_releasers({
          payer: signerAddress(params.payer),
          payee: params.payee,
          token: params.token,
          amount: params.amount,
          condition_ref: params.conditionRef,
          releasers: params.releasers,
          threshold: params.threshold,
          refund_after: params.refundAfter,
          notify_payee: params.notifyPayee ?? false,
          refund_to: params.refundTo,
        }),
      { address: signerAddress(params.payer) },
    );
    return { escrowId: sent.result.unwrap(), txHash: sent.sendTransactionResponse!.hash };
  }

  /**
   * Read-only: everything stored about `escrowId` — including the
   * `releasers` set, its `threshold` and `refundAfter`, which payees should
   * check before relying on a `Funded` escrow (docs/adr/0004, threat model
   * T8). Throws if `escrowId` doesn't exist, **and also once the escrow has
   * settled**: its record is reclaimed (docs/adr/0013). Use `getStatus` for a
   * settled id and the `ESCROW` state event for its history.
   */
  async getEscrow(escrowId: bigint): Promise<Escrow> {
    await this.ensureNetworkVerified();
    const client = this.contractClient();
    const tx = await tracePhase(
      this.instrumentation,
      "simulate",
      this.spanAttributesIfEnabled("get_escrow", escrowId),
      () => client.get_escrow({ escrow_id: escrowId }),
    );
    let data: GeneratedEscrowData;
    try {
      data = tx.result.unwrap();
    } catch (error) {
      // The generated bindings embed the current contract spec. A testnet
      // deployment that predates a newly added `EscrowData` field still
      // returns a valid map, but the SDK's positional struct decoder can
      // mis-read it (for example before `release_not_before` existed).
      // Decode the same map by field name so reads keep working across
      // deployed contract versions (issue #224).
      const retval = error instanceof TypeError
        ? tx.simulationData.result?.retval
        : undefined;
      if (retval?.switch().name === "scvMap") {
        return decodeEscrowDataFromScVal(retval);
      }
      throw error;
    }
    return {
      payer: data.payer,
      payee: data.payee,
      token: data.token,
      amount: data.amount,
      conditionRef: data.condition_ref,
      releasers: data.releasers,
      threshold: data.threshold,
      // The generated client decodes a contract `None` as `null`; the
      // public surface uses `undefined` for "no deadline" (consistent
      // with `CreateEscrowParams.refundAfter` being absent).
      refundAfter: data.refund_after ?? undefined,
      notifyPayee: data.notify_payee,
      refundTo: data.refund_to,
      releaseNotBefore: data.release_not_before ?? undefined,
      feeRecipient: data.fee_recipient ?? undefined,
      feeBps: data.fee_bps ?? undefined,
      requiresAcceptance: data.requires_acceptance,
      acceptedAt: data.accepted_at ?? undefined,
      status: data.status.tag,
    };
  }

  /**
   * Creates a milestone escrow: one single-tranche escrow per entry in
   * `milestones`, created in schedule order.
   *
   * The deployed contract is single-tranche, so a milestone schedule is
   * modelled client-side as a *group* of escrows rather than a new contract
   * entry point. That keeps every guarantee the contract already gives —
   * per-tranche releaser auth, refund deadlines, `Funded`/`Released` state —
   * and needs no contract change. Trade-offs, all visible in the return
   * value:
   *  - each tranche is its own escrow, so `releaseMilestone` /
   *    `refundMilestone` act on one `escrowId` at a time;
   *  - `payer` signs one transaction per tranche, so a group costs N
   *    transactions ("N tranches = N escrows" is logged in `conditionRef`
   *    as `<conditionRef>#m<i+1>/<n>`);
   *  - creation is sequential and not atomic: if tranche *k* fails, the
   *    earlier escrows already exist and are funded. The thrown
   *    `MilestoneEscrowPartialError` carries their ids so the caller can
   *    release or refund them.
   *
   * `milestones` must be positive and sum exactly to `amount`, validated
   * before the first transaction (`MilestoneScheduleError`).
   */
  async createMilestoneEscrow(params: CreateMilestoneEscrowParams): Promise<MilestoneEscrow> {
    validateMilestoneSchedule(params.milestones, params.amount);

    // Validate every tagged ref up front: failing on tranche 3 after 2
    // funded escrows exist is exactly the partial state this API must avoid.
    const refs = params.milestones.map((_, index) =>
      milestoneConditionRef(params.conditionRef, index, params.milestones.length),
    );

    const created: Milestone[] = [];
    const { milestones: schedule, ...escrowParams } = params;
    for (const [index, amount] of schedule.entries()) {
      try {
        const { escrowId } = await this.createEscrow({
          ...escrowParams,
          amount,
          conditionRef: refs[index],
        });
        created.push({ index, amount, escrowId, status: "unreleased" });
      } catch (error) {
        throw new MilestoneEscrowPartialError(
          created.map((milestone) => milestone.escrowId),
          created.length,
          schedule.length,
          error,
        );
      }
    }

    return {
      milestones: created,
      escrowIds: created.map((milestone) => milestone.escrowId),
    };
  }

  /**
   * Releases one tranche to the payee. `caller` must be that tranche's
   * `releaser`; out-of-order release is fine. Each tranche can be released
   * at most once, because each is its own single-tranche escrow. Returns the
   * transaction's hash.
   */
  async releaseMilestone(params: ReleaseMilestoneParams): Promise<{ txHash: string }> {
    const { escrowId } = trancheOf(params.escrow, params.milestoneIndex);
    return this.release({ escrowId, caller: params.caller });
  }

  /** Refunds one unreleased tranche to its `refundTo` — same rules as `refund`. */
  async refundMilestone(params: RefundMilestoneParams): Promise<{ txHash: string }> {
    const { escrowId } = trancheOf(params.escrow, params.milestoneIndex);
    return this.refund({ escrowId, caller: params.caller });
  }

  /**
   * Read-only: re-reads every tranche's escrow and reports it as
   * `"unreleased"` (`Funded`), `"released"` (`Released`) or `"refunded"`
   * (anything terminal otherwise). One `get_escrow` per tranche.
   */
  async getMilestones(escrow: MilestoneEscrow): Promise<Milestone[]> {
    return Promise.all(
      escrow.milestones.map(async ({ index, amount, escrowId }) => {
        const status = (await this.getEscrow(escrowId)).status;
        return {
          index,
          amount,
          escrowId,
          status: status === "Released" ? "released" : status === "Funded" ? "unreleased" : "refunded",
        } satisfies Milestone;
      }),
    );
  }

  /** Moves the escrow's funds to its payee. Throws if `caller` isn't the escrow's `releaser`, or the escrow isn't `Funded`. Returns the transaction's hash. */
  async release(params: ReleaseOrRefundParams): Promise<{ txHash: string }> {
    const client = this.contractClient(params.caller);
    const sent = await this.invoke(
      "release",
      params.escrowId,
      () => client.release({ escrow_id: params.escrowId, caller: signerAddress(params.caller) }),
      { address: signerAddress(params.caller) },
    );
    sent.result.unwrap();
    return { txHash: sent.sendTransactionResponse!.hash };
  }

  /**
   * Payer-side withdrawal before the payee accepts (docs/adr/0010): returns
   * the escrow's funds to its `refundTo` and marks it `Cancelled`. Only the
   * escrow's payer may call it, only while it is `Funded`, was created with
   * the acceptance gate, and the payee has not accepted. Returns the
   * transaction's hash.
   */
  async cancel(params: CancelParams): Promise<{ txHash: string }> {
    await this.ensureNetworkVerified();
    const payer = signerAddress(params.payer);
    const call: LifecycleCall = { method: "cancel", escrowId: params.escrowId, payer };
    if (params.checkPreconditions !== false) await this.checkLifecycleCall(call);
    const client = this.contractClient(params.payer);
    const sent = await this.invoke(
      "cancel",
      params.escrowId,
      () => client.cancel({ escrow_id: params.escrowId, payer }),
      { address: payer },
    );
    sent.result.unwrap();
    return { txHash: sent.sendTransactionResponse!.hash };
  }

  /**
   * Adds `amount` to a `Funded` escrow without changing its parties or id
   * (issue #26). Only the escrow's original payer may top up; pooled
   * escrows grow through `contribute` instead and are rejected by the
   * contract (`NotSupportedForPooled`). Returns the transaction's hash.
   */
  async topUp(params: TopUpParams): Promise<{ txHash: string }> {
    const payer = signerAddress(params.payer);
    const call: LifecycleCall = { method: "top_up", escrowId: params.escrowId, payer, amount: params.amount };
    assertPositiveAmount(call);
    if (params.checkPreconditions !== false) await this.checkLifecycleCall(call);
    const client = this.contractClient(params.payer);
    const sent = await this.invoke(
      "top_up",
      params.escrowId,
      () => client.top_up({ escrow_id: params.escrowId, payer, amount: params.amount }),
      { address: payer },
    );
    sent.result.unwrap();
    return { txHash: sent.sendTransactionResponse!.hash };
  }

  /**
   * Records the payee's acceptance on an escrow created with the
   * acceptance gate (issue #25). Once accepted, the payer can no longer
   * `cancel`. One-time and only while `Funded`. Returns the transaction's
   * hash.
   */
  async accept(params: AcceptParams): Promise<{ txHash: string }> {
    const payee = signerAddress(params.payee);
    const call: LifecycleCall = { method: "accept", escrowId: params.escrowId, payee };
    if (params.checkPreconditions !== false) await this.checkLifecycleCall(call);
    const client = this.contractClient(params.payee);
    const sent = await this.invoke(
      "accept",
      params.escrowId,
      () => client.accept({ escrow_id: params.escrowId, payee }),
      { address: payee },
    );
    sent.result.unwrap();
    return { txHash: sent.sendTransactionResponse!.hash };
  }

  /**
   * Step 1 of the multi-party flow: simulates `call` with `source` as the
   * transaction source and returns it as portable JSON, listing every other
   * party whose contract authorization is still needed. Pass the result to
   * each of them for `signLifecycleCall`, then to the source for
   * `submitLifecycleCall`. Nothing is signed here.
   */
  async prepareLifecycleCall(params: PrepareLifecycleParams): Promise<PreparedLifecycleCall> {
    const { call } = params;
    if (call.method === "top_up") assertPositiveAmount(call);
    await this.ensureNetworkVerified();
    if (params.checkPreconditions !== false) await this.checkLifecycleCall(call);
    const source = params.source ?? lifecycleCallSigner(call);
    const client = this.contractClientForAddress(source);
    const tx = await this.buildLifecycleCall(client, call);
    if (tx.isReadCall) {
      throw new Error(`${call.method} was simulated as a read call; no transaction was assembled.`);
    }
    const latestLedger = await this.rpc.getLatestLedger();
    return {
      method: call.method,
      transaction: tx.toJSON(),
      source,
      pendingSigners: tx.needsNonInvokerSigningBy(),
      expiresAtLedger: latestLedger.sequence + (params.ttlLedgers ?? PREPARED_AUTH_TTL_LEDGERS),
    };
  }

  /**
   * Step 2: signs `signer`'s contract auth entry in a prepared call and
   * returns the updated call with `signer` removed from `pendingSigners`.
   * Safe to run in a separate process from `prepareLifecycleCall`; the
   * signer never sees or signs the envelope.
   */
  async signLifecycleCall(
    prepared: PreparedLifecycleCall,
    signer: EscrowSigner,
  ): Promise<PreparedLifecycleCall> {
    const address = signerAddress(signer);
    if (!prepared.pendingSigners.includes(address)) {
      throw new Error(`${address} has no pending authorization in this ${prepared.method} call.`);
    }
    const client = this.contractClientForAddress(prepared.source);
    const tx = client.txFromJSON<Result<void>>(prepared.transaction);
    await tx.signAuthEntries({ signAuthEntry: signer, expiration: prepared.expiresAtLedger });
    return {
      ...prepared,
      transaction: tx.toJSON(),
      pendingSigners: tx.needsNonInvokerSigningBy(),
    };
  }

  /**
   * Step 3: the source signs the envelope and submits. Refuses to submit
   * while any party's authorization is still missing, or when `expectedMethod`
   * does not match, so a call meant for one function cannot be passed off as
   * another. Returns the transaction's hash.
   */
  async submitLifecycleCall(
    prepared: PreparedLifecycleCall,
    source: EscrowSigner,
    expectedMethod?: LifecycleMethod,
  ): Promise<{ txHash: string }> {
    let method: unknown;
    try {
      method = (JSON.parse(prepared.transaction) as { method?: unknown }).method;
    } catch (error) {
      throw new TypeError(`Prepared call is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (method !== prepared.method || (expectedMethod && method !== expectedMethod)) {
      throw new TypeError(
        `Prepared call is for ${String(method) || "an unknown method"}, not ${expectedMethod ?? prepared.method}.`
      );
    }
    if (signerAddress(source) !== prepared.source) {
      throw new Error(`Prepared call must be submitted by its source ${prepared.source}.`);
    }
    await this.ensureNetworkVerified();
    const client = this.contractClient(source);
    const tx = client.txFromJSON<Result<void>>(prepared.transaction);
    const missing = tx.needsNonInvokerSigningBy();
    if (missing.length > 0) {
      throw new Error(`Still waiting for authorization from: ${missing.join(", ")}.`);
    }
    const sent = await tx.signAndSend();
    sent.result.unwrap();
    return { txHash: sent.sendTransactionResponse!.hash };
  }

  /** A contract client that simulates as `address` without being able to sign. */
  private contractClientForAddress(address: string): EscrowContractClient {
    return new EscrowContractClient({
      contractId: this.contractId,
      rpcUrl: this.rpcUrl,
      networkPassphrase: this.networkPassphrase,
      allowHttp: this.allowHttp,
      publicKey: address,
    });
  }

  private buildLifecycleCall(
    client: EscrowContractClient,
    call: LifecycleCall,
  ): Promise<AssembledTransaction<Result<void>>> {
    switch (call.method) {
      case "top_up":
        return client.top_up({ escrow_id: call.escrowId, payer: call.payer, amount: call.amount });
      case "accept":
        return client.accept({ escrow_id: call.escrowId, payee: call.payee });
      case "cancel":
        return client.cancel({ escrow_id: call.escrowId, payer: call.payer });
    }
  }

  /**
   * Client-side precondition check: reads the escrow once and throws
   * `EscrowPreconditionError` for anything the contract would certainly
   * reject. Rules mirror `contracts/escrow/src/lib.rs`.
   */
  private async checkLifecycleCall(call: LifecycleCall): Promise<void> {
    const escrow = await this.getEscrow(call.escrowId);
    const fail = (code: EscrowPreconditionCode, message: string): never => {
      throw new EscrowPreconditionError(call.method, code, message);
    };
    // Same order as the contract, so the error matches what it would return.
    const [party, expected] = call.method === "accept"
      ? ["payee", escrow.payee] as const
      : ["payer", escrow.payer] as const;
    if (lifecycleCallSigner(call) !== expected) {
      fail("Unauthorized", `only the escrow's ${party} can call ${call.method}.`);
    }
    if (escrow.status !== "Funded") {
      fail("NotFunded", `escrow ${call.escrowId} is ${escrow.status}, not Funded.`);
    }
    if (call.method === "top_up") return;
    if (!escrow.requiresAcceptance) {
      fail("AcceptanceNotConfigured", "the escrow was created without the acceptance gate.");
    }
    if (escrow.acceptedAt !== undefined) fail("AlreadyAccepted", "the payee has already accepted.");
  }

  /**
   * Creates a pooled escrow (issue #113, docs/adr/0011): one agreement
   * that many payers fund with `contribute`. Creation moves no tokens —
   * the pool starts at 0 and grows to `fundingTarget`. Release becomes
   * possible only at exactly the target; if `fundingDeadline` passes
   * first, the round failed and each contributor pulls their own record
   * back with `claimRefund`. Returns the new escrow id and tx hash.
   */
  async createPooledEscrow(
    params: CreatePooledEscrowParams
  ): Promise<{ escrowId: bigint; txHash: string }> {
    if (params.conditionRef.length > MAX_CONDITION_REF_LENGTH) {
      throw new Error(
        `conditionRef must be at most ${MAX_CONDITION_REF_LENGTH} bytes, got ${params.conditionRef.length}`
      );
    }
    if (params.fundingTarget <= 0n) {
      throw new Error(`fundingTarget must be a positive raw amount, got ${params.fundingTarget}`);
    }
    if (params.fundingDeadline <= 0n) {
      throw new Error(
        `fundingDeadline must be a positive unix timestamp in seconds, got ${params.fundingDeadline}`
      );
    }
    const client = this.contractClient(params.creator);
    const sent = await this.invoke(
      "create_pooled_escrow",
      undefined,
      () =>
        client.create_pooled_escrow({
          creator: signerAddress(params.creator),
          payee: params.payee,
          token: params.token,
          funding_target: params.fundingTarget,
          condition_ref: params.conditionRef,
          releaser: params.releaser,
          funding_deadline: params.fundingDeadline,
        }),
      { address: signerAddress(params.creator) },
    );
    return { escrowId: sent.result.unwrap(), txHash: sent.sendTransactionResponse!.hash };
  }

  /**
   * Contributes `amount` to a pooled escrow from `payer` (docs/adr/0011).
   * Accepted only before the funding deadline and only while the pool
   * stays at or under its target; the contract verifies the received
   * amount with a balance-delta check and records it against `payer`,
   * accumulating across repeat contributions. Returns the tx hash.
   */
  async contribute(params: ContributeParams): Promise<{ txHash: string }> {
    if (params.amount <= 0n) {
      throw new Error(`amount must be a positive raw amount, got ${params.amount}`);
    }
    const client = this.contractClient(params.payer);
    const sent = await this.invoke(
      "contribute",
      params.escrowId,
      () =>
        client.contribute({
          escrow_id: params.escrowId,
          payer: signerAddress(params.payer),
          amount: params.amount,
        }),
      { address: signerAddress(params.payer) },
    );
    sent.result.unwrap();
    return { txHash: sent.sendTransactionResponse!.hash };
  }

  /**
   * Pull-based refund of a failed funding round (docs/adr/0011): pays
   * `contributor` exactly their recorded amount, once. Only available
   * after the funding deadline passed below the target, and never after
   * a release. The contributor signs their own claim; anyone else's
   * claim of this record is impossible. Returns the tx hash.
   */
  async claimRefund(params: ClaimRefundParams): Promise<{ txHash: string }> {
    const client = this.contractClient(params.contributor);
    const sent = await this.invoke(
      "claim_refund",
      params.escrowId,
      () =>
        client.claim_refund({
          escrow_id: params.escrowId,
          contributor: signerAddress(params.contributor),
        }),
      { address: signerAddress(params.contributor) },
    );
    sent.result.unwrap();
    return { txHash: sent.sendTransactionResponse!.hash };
  }

  /**
   * Read-only: a pooled escrow's immutable funding config. Combine with
   * `getEscrow().amount` and the current ledger time to classify the
   * round: `amount === fundingTarget` succeeded (releasable at any time);
   * `now >= fundingDeadline && amount < fundingTarget` failed
   * (`claimRefund` is open). A failed round still reads `"Funded"` from
   * `getStatus` — status describes settlement, not funding. Throws
   * `NotPooled` (error 26) on a non-pooled or unknown id.
   */
  async getPooled(escrowId: bigint): Promise<PooledEscrow> {
    await this.ensureNetworkVerified();
    const client = this.contractClient();
    const tx = await tracePhase(
      this.instrumentation,
      "simulate",
      this.spanAttributesIfEnabled("get_pooled", escrowId),
      () => client.get_pooled({ escrow_id: escrowId }),
    );
    const data: GeneratedPooledData = tx.result.unwrap();
    return {
      fundingTarget: data.funding_target,
      fundingDeadline: data.funding_deadline,
    };
  }

  /**
   * Read-only: one contributor's record on a pooled escrow — the exact
   * amount they can claim from a failed round and whether it is already
   * claimed. `undefined` means the address never contributed. Throws
   * `NotFound` (1) on an unknown id, `NotPooled` (26) on a non-pooled one.
   */
  async getContribution(
    escrowId: bigint,
    contributor: string
  ): Promise<ContributionRecord | undefined> {
    await this.ensureNetworkVerified();
    const client = this.contractClient();
    const tx = await tracePhase(
      this.instrumentation,
      "simulate",
      this.spanAttributesIfEnabled("get_contribution", escrowId, contributor),
      () => client.get_contribution({ escrow_id: escrowId, contributor }),
    );
    const record: GeneratedContribution | undefined = tx.result.unwrap();
    if (record == null) return undefined;
    return { amount: record.amount, refunded: record.refunded };
  }

  /**
   * Read-only solvency check for one token (issue #39): the contract's
   * balance of `token` and its total outstanding liability in it (the sum
   * of `amount` over every `Funded` escrow, maintained on-chain in the
   * same invocation as each state change). `solvent` is false only when
   * the contract holds less than it owes, e.g. after an issuer clawback
   * (threat model T5). A token never used reports zero liabilities.
   */
  async getSolvency(token: string): Promise<SolvencyReport> {
    const client = this.contractClient();
    const tx = await tracePhase(
      this.instrumentation,
      "simulate",
      this.spanAttributesIfEnabled("solvency"),
      () => client.solvency({ token }),
    );
    const [balance, liabilities] = tx.result;
    return { balance, liabilities, solvent: balance >= liabilities };
  }

  /**
   * Returns the escrow's funds to its `refundTo` (the payer unless a
   * sponsored escrow set another destination, docs/adr/0009). Normally `caller` must be
   * the escrow's `releaser`; once `refundAfter` has passed, anyone may
   * call it — still only back to the payer (docs/adr/0004). Returns the
   * transaction's hash.
   */
  async refund(params: ReleaseOrRefundParams): Promise<{ txHash: string }> {
    const client = this.contractClient(params.caller);
    const sent = await this.invoke(
      "refund",
      params.escrowId,
      () => client.refund({ escrow_id: params.escrowId, caller: signerAddress(params.caller) }),
      { address: signerAddress(params.caller) },
    );
    sent.result.unwrap();
    return { txHash: sent.sendTransactionResponse!.hash };
  }

  /**
   * Simulates a `release`, has the releaser sign only its short-lived contract
   * authorization entry, and returns the resulting transaction for a separate
   * relayer to sign and submit. The relayer is the transaction source, so it
   * pays the fee; no envelope signature is collected here. Keep the returned
   * authorization private and submit it before `expiresAtLedger`.
   */
  async authorizeRelease(params: RelayedAuthorizationParams): Promise<RelayedAuthorization> {
    return this.authorizeSettlement("release", params);
  }

  /**
   * Simulates a `refund` and collects only the releaser's contract auth entry,
   * leaving the envelope for the relayer to sign and pay for. Same lifetime and
   * privacy rules as `authorizeRelease`.
   */
  async authorizeRefund(params: RelayedAuthorizationParams): Promise<RelayedAuthorization> {
    return this.authorizeSettlement("refund", params);
  }

  private async authorizeSettlement(
    settlement: "release" | "refund",
    params: RelayedAuthorizationParams,
  ): Promise<RelayedAuthorization> {
    await this.ensureNetworkVerified();
    const client = this.contractClient(params.relayer);
    const tx = settlement === "release"
      ? await client.release({ escrow_id: params.escrowId, caller: params.releaser.publicKey() })
      : await client.refund({ escrow_id: params.escrowId, caller: params.releaser.publicKey() });

    if (tx.isReadCall) {
      throw new Error(`${settlement} was simulated as a read call; no transaction was assembled.`);
    }

    const latestLedger = await this.rpc.getLatestLedger();
    const expiresAtLedger = latestLedger.sequence + RELAYED_AUTH_TTL_LEDGERS;

    // The relayer is the transaction source, so the envelope signature covers
    // its own auth; only the releaser's separate auth entry needs signing here.
    if (tx.needsNonInvokerSigningBy().includes(params.releaser.publicKey())) {
      await tx.signAuthEntries({
        signAuthEntry: params.releaser,
        expiration: expiresAtLedger,
      });
    }

    return { transaction: tx.toJSON(), expiresAtLedger };
  }

  /**
   * Signs a relayed authorization's envelope as `relayer` and submits it.
   * Rejects an authorization for a different settlement method than the one
   * named, so a `release` authorization cannot be smuggled through `refund`.
   * Returns the submitted transaction's hash.
   */
  async submitRelayed(
    settlement: "release" | "refund",
    authorization: RelayedAuthorization,
    relayer: EscrowSigner,
  ): Promise<{ txHash: string }> {
    let method: unknown;
    try {
      method = (JSON.parse(authorization.transaction) as { method?: unknown }).method;
    } catch (error) {
      throw new TypeError(`Relayed authorization is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (method !== settlement) {
      throw new TypeError(
        `Relayed authorization is for ${String(method) || "an unknown method"}, not ${settlement}.`
      );
    }

    await this.ensureNetworkVerified();
    const client = this.contractClient(relayer);
    const tx = client.txFromJSON<Result<void>>(authorization.transaction);
    const sent = await tx.signAndSend();
    sent.result.unwrap();
    return { txHash: sent.sendTransactionResponse!.hash };
  }

  /**
   * Estimates what a contract call will cost, in stroops, by simulating it
   * against the configured RPC. Nothing is signed or submitted.
   *
   * The resource fee carries a 20% buffer over the simulated minimum (rounded
   * up), because simulation can be a strop or two short of the real charge;
   * `minResourceFee` exposes the raw figure for callers that want their own
   * margin. Sponsors should treat `total` as the expected cost, not a promise
   * — fee-bump it with `maxFee` set to the most they are willing to pay.
   */
  async estimate(call: EstimateCallParams): Promise<FeeEstimate> {
    await this.ensureNetworkVerified();
    const contractId = call.contractId ?? this.contractId;
    const account = await this.rpc.getAccount(signerAddress(call.source));
    const transaction = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract: contractId,
          function: call.method,
          args: call.args ?? [],
        }),
      )
      .setTimeout(30)
      .build();

    const estimateAttributes = isInstrumentationEnabled(this.instrumentation)
      ? { "contract.id": contractId, "contract.function": call.method }
      : EMPTY_SPAN_ATTRIBUTES;
    const simulation = await tracePhase(
      this.instrumentation,
      "simulate",
      estimateAttributes,
      () => this.rpc.simulateTransaction(transaction),
    );
    if (Api.isSimulationError(simulation)) {
      throw new Error(`Simulation failed for ${call.method}: ${simulation.error}`);
    }
    return computeFeeEstimate({
      minResourceFee: BigInt(simulation.minResourceFee),
      inclusionFee: BigInt(BASE_FEE) * BigInt(transaction.operations.length),
    });
  }

  /**
   * Wraps an already-signed transaction in a fee-bump paid by `sponsorSigner`.
   *
   * The wrapper's fee is `baseFee × (inner operations + 1)`, charged by the
   * fee-bump envelope; the cap is checked before anything is built, so a spike
   * either fits `maxFee` or throws `MaxFeeExceededError` — it is never silently
   * exceeded. Run `guardSponsorship` first when the inner transaction comes
   * from someone else.
   */
  feeBump(signedXdr: string, sponsorSigner: Keypair, options: FeeBumpOptions): FeeBumpResult {
    const inner = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase);
    if (!(inner instanceof Transaction)) {
      throw new TypeError("feeBump expects a regular signed transaction, not an already fee-bumped envelope.");
    }
    const baseFee = options.baseFee ?? BigInt(BASE_FEE);
    if (baseFee < 1n) throw new RangeError("baseFee must be at least 1 strop.");
    const maxFee = BigInt(options.maxFee);
    if (maxFee < 0n) throw new RangeError("maxFee must not be negative.");

    // A fee-bump envelope carries one operation (the wrapped inner tx), so it
    // costs baseFee × (inner ops + 1). The inner fee itself is refunded.
    const fee = baseFee * BigInt(inner.operations.length + 1);
    if (fee > maxFee) throw new MaxFeeExceededError(fee, maxFee);

    const bump = TransactionBuilder.buildFeeBumpTransaction(
      sponsorSigner,
      baseFee.toString(),
      inner,
      this.networkPassphrase,
    );
    bump.sign(sponsorSigner);
    return { xdr: bump.toXDR(), fee, innerTxHash: inner.hash().toString("hex") };
  }

  /**
   * Verifies that a transaction only touches this escrow contract before a
   * sponsor pays for it. Every operation is inspected, and so is every
   * contract-address auth entry — an invocation can otherwise smuggle in a
   * transfer authorized against another contract. Account-address auth entries
   * (the payer/releaser signatures) are expected and allowed.
   */
  guardSponsorship(signedXdr: string): GuardResult {
    const reasons: string[] = [];
    const invokedContracts = new Set<string>();

    let inner: Transaction | FeeBumpTransaction;
    try {
      inner = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase);
    } catch (error) {
      return {
        ok: false,
        reasons: [`could not decode transaction envelope: ${error instanceof Error ? error.message : String(error)}`],
        invokedContracts: [],
      };
    }
    // A fee-bump envelope is not sponsorable again; unwrap it so the inner
    // transaction is what gets judged (its hash is what executes).
    const transaction = inner instanceof FeeBumpTransaction ? inner.innerTransaction : inner;
    if (inner instanceof FeeBumpTransaction) {
      reasons.push("envelope is already a fee-bump transaction");
    }

    for (const operation of transaction.operations) {
      if (operation.type !== "invokeHostFunction") {
        reasons.push(`operation type "${operation.type}" is not a contract invocation`);
        continue;
      }
      const fn = operation.func;
      if (fn.switch().name !== "hostFunctionTypeInvokeContract") {
        reasons.push(`host function "${fn.switch().name}" is not a contract invocation`);
        continue;
      }
      const contractId = contractAddressOf(fn.invokeContract().contractAddress());
      if (!contractId) {
        reasons.push("contract invocation has no contract address");
        continue;
      }
      invokedContracts.add(contractId);
      if (contractId !== this.contractId) {
        reasons.push(`operation invokes foreign contract ${contractId}`);
      }

      for (const entry of operation.auth ?? []) {
        const credentials = entry.credentials();
        if (credentials.switch().name !== "sorobanCredentialsAddress") continue;
        const authContract = contractAddressOf(credentials.address().address());
        if (authContract && authContract !== this.contractId) {
          reasons.push(`auth entry targets foreign contract ${authContract}`);
        }
      }
    }

    if (transaction.operations.length === 0) reasons.push("transaction has no operations");
    return { ok: reasons.length === 0, reasons, invokedContracts: [...invokedContracts] };
  }

  /** Throws `SponsorshipGuardError` when `guardSponsorship` would reject. */
  assertSponsorable(signedXdr: string): void {
    const result = this.guardSponsorship(signedXdr);
    if (!result.ok) throw new SponsorshipGuardError(result.reasons);
  }

  /**
   * Releases an M-of-N escrow to its payee with at least `threshold`
   * distinct releaser approvals (docs/adr/0007). Each supplied keypair signs
   * the contract auth entry for this exact call; the first also pays the fee.
   * Returns the transaction's hash.
   */
  async releaseWithApprovals(params: SettlementApprovalsParams): Promise<{ txHash: string }> {
    return this.settleWithApprovals("release", params);
  }

  /**
   * Refunds an M-of-N escrow back to its payer with at least `threshold`
   * distinct releaser approvals (docs/adr/0007). The `refundAfter` timeout
   * path (`refund`) stays open to anyone and needs no approvals. Returns the
   * transaction's hash.
   */
  async refundWithApprovals(params: SettlementApprovalsParams): Promise<{ txHash: string }> {
    return this.settleWithApprovals("refund", params);
  }

  private async settleWithApprovals(
    settlement: "release" | "refund",
    params: SettlementApprovalsParams
  ): Promise<{ txHash: string }> {
    if (params.approvers.length === 0) {
      throw new Error("approvers must contain at least one releaser keypair");
    }
    const [invoker, ...additionalSigners] = params.approvers;
    const approverAddresses = params.approvers.map(signerAddress);
    if (new Set(approverAddresses).size !== approverAddresses.length) {
      throw new Error("approvers must not repeat a releaser keypair");
    }

    const client = this.contractClient(invoker);
    const sent = await this.invoke(
      settlement === "release" ? "release_with_approvals" : "refund_with_approvals",
      params.escrowId,
      () =>
        settlement === "release"
          ? client.release_with_approvals({ escrow_id: params.escrowId, approvers: approverAddresses })
          : client.refund_with_approvals({ escrow_id: params.escrowId, approvers: approverAddresses }),
      {
        address: signerAddress(invoker),
        beforeSign: async (tx) => {
          // Every non-invoker approver signs the contract auth entry. This is
          // part of the "sign" phase, so one span covers all signatures.
          for (const signer of additionalSigners) {
            await tx.signAuthEntries({ signAuthEntry: signer });
          }
        },
      },
    );
    sent.result.unwrap();
    return { txHash: sent.sendTransactionResponse!.hash };
  }

  /** Reads one page of lifecycle events emitted by this escrow contract. */
  async getEvents(params: GetEventsParams): Promise<GetEventsResult> {
    if (params.cursor !== undefined && params.fromLedger !== undefined) {
      throw new TypeError("Provide either cursor or fromLedger, not both.");
    }
    if (params.fromLedger !== undefined && (!Number.isSafeInteger(params.fromLedger) || params.fromLedger < 1)) {
      throw new RangeError("fromLedger must be a positive safe integer.");
    }
    // Validate the arguments before any network work, so a bad call fails
    // fast and never depends on RPC availability.
    await this.ensureNetworkVerified();
    const filter: Api.EventFilter = { type: "contract", contractIds: [this.contractId] };
    const request: Api.GetEventsRequest = "cursor" in params && params.cursor !== undefined
      ? { cursor: params.cursor, filters: [filter], limit: 100 }
      : { startLedger: params.fromLedger, filters: [filter], limit: 100 };
    let response: Api.GetEventsResponse;
    try {
      response = await this.rpc.getEvents(request);
    } catch (error) {
      if (isRetentionError(error)) throw new EventCursorExpiredError(error instanceof Error ? error.message : undefined);
      throw error;
    }
    const allowed = params.types ? new Set(params.types) : undefined;
    const events: EscrowEvent[] = [];
    for (const raw of response.events) {
      if (raw.type !== "contract" || raw.contractId?.toString() !== this.contractId) continue;
      const nativeTopics = raw.topic.map(safeScValToNative);
      const eventName = nativeTopics.find((v) => v === "created" || v === "released" || v === "refunded" || v === "cancelled") as EscrowEventType | undefined;
      const unknownName = nativeTopics.find((v) => typeof v === "string") as string | undefined;
      const type = eventName;
      if (type && allowed && !allowed.has(type)) continue;
      const rawId = nativeTopics.find((v): v is bigint | number => typeof v === "bigint" || (typeof v === "number" && Number.isSafeInteger(v)));
      const escrowId = rawId === undefined ? undefined : BigInt(rawId);
      if (params.escrowId !== undefined && escrowId !== params.escrowId) continue;
      const base = { ledger: raw.ledger, cursor: raw.id, transactionHash: raw.txHash, data: safeScValToNative(raw.value) };
      if (type && escrowId !== undefined) events.push({ ...base, type, escrowId });
      else events.push({ ...base, type: "unknown", ...(unknownName ? { eventName: unknownName } : {}), ...(escrowId !== undefined ? { escrowId } : {}), topics: nativeTopics });
    }
    return { events, nextCursor: response.cursor };
  }

  /**
   * Polls event pages in order. Each handler call is awaited before the next
   * event is delivered, so slow handlers apply back-pressure without drops.
   * The returned stop function ends polling; persist the last delivered
   * event cursor (or the cursor from getEvents) to resume after restart.
   */
  subscribe(handler: (event: EscrowEvent) => void | Promise<void>, options: SubscribeOptions = {}): () => void {
    const pollIntervalMs = options.pollIntervalMs ?? 5_000;
    if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 1) throw new RangeError("pollIntervalMs must be at least 1.");
    let stopped = false;
    let cursor = options.cursor;
    const poll = async (): Promise<void> => {
      while (!stopped) {
        try {
          const page = cursor !== undefined
            ? await this.getEvents({ cursor, types: options.types, escrowId: options.escrowId })
            : await this.getEvents({ fromLedger: (await this.rpc.getLatestLedger()).sequence, types: options.types, escrowId: options.escrowId });
          for (const event of page.events) {
            if (stopped) break;
            await handler(event);
            cursor = event.cursor;
          }
          // Advance across pages with no matching events, including filtered events.
          cursor = page.nextCursor;
        } catch (error) {
          if (!stopped) {
            if (options.onError) options.onError(error);
            else queueMicrotask(() => { throw error; });
          }
          return;
        }
        if (!stopped) await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
      }
    };
    void poll();
    return () => { stopped = true; };
  }
}