// Multisig releaser account helpers (Phase E6, T1 mitigation).
//
// T1's cheapest mitigation needs no contract change: make the releaser a
// Stellar account with M-of-N signers. Setting that up correctly (signer
// weights, thresholds, removing the master key without locking yourself out)
// is error-prone. This module makes the safe configuration the easy one.
//
// Hard rules (ARCHITECTURE_ESSENTIALS.md): no PHI or healthcare concepts,
// tests for every contract change, strict semver for the SDK, testnet only.
// This module is purely client-side and never touches a contract.

import {
  Account,
  BASE_FEE,
  Operation,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import type { Horizon } from "@stellar/stellar-sdk";

/** Standard Stellar network passphrase for testnet. */
export const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

// Stellar signer weights and thresholds are unsigned 8-bit integers (0..255).
// The master key is always identified by the account's own public key.
export const MIN_WEIGHT = 0;
export const MAX_WEIGHT = 255;

/** A single signer entry in the intended multisig policy. */
export interface MultisigSigner {
  /** Stellar account address (G…). */
  key: string;
  /** Signer weight, 1..255. */
  weight: number;
}

/** The intended on-chain multisig policy. */
export interface MultisigPolicy {
  /** The account being configured. */
  account: string;
  /**
   * Signers that will be authorized to sign. The account's own key may be
   * listed only when `removeMasterKey` is `false`; its weight is then applied
   * as the master key weight.
   */
  signers: MultisigSigner[];
  /** Default for `lowThreshold`, `mediumThreshold` and `highThreshold`. */
  threshold: number;
  /** Defaults to `threshold`. */
  lowThreshold?: number;
  /** Defaults to `threshold`. */
  mediumThreshold?: number;
  /** Defaults to `threshold`. */
  highThreshold?: number;
  /**
   * Whether to zero out the master key weight. Defaults to `true`: the whole
   * point of a multisig releaser is to remove the single point of failure.
   */
  removeMasterKey?: boolean;
}

/** A policy with every optional field resolved. */
export type ResolvedMultisigPolicy = Required<MultisigPolicy>;

/** Result of a dry-run of the multisig setup. */
export interface MultisigDryRun {
  /** The validated policy that would be applied. */
  policy: ResolvedMultisigPolicy;
  /** Sum of all signer weights after the setup. */
  totalWeight: number;
  /** Sum of weights of the signers that can still sign after the setup. */
  remainingWeight: number;
  /** Weight of the master key after the setup. */
  masterKeyWeight: number;
  /** Number of `setOptions` operations the setup transaction contains. */
  operationCount: number;
  /** A readable summary for logging. */
  summary: string;
}

/** Thrown when a proposed multisig configuration would lock out the account. */
export class MultisigLockOutError extends Error {
  constructor(
    message: string,
    public readonly reasons: string[],
  ) {
    super(message);
    this.name = "MultisigLockOutError";
  }
}

/** Thrown when a policy is structurally invalid (bad weights, duplicates, …). */
export class MultisigValidationError extends Error {
  constructor(
    message: string,
    public readonly reasons: string[],
  ) {
    super(message);
    this.name = "MultisigValidationError";
  }
}

/** Result of {@link buildMultisigSetup}. */
export interface MultisigSetupResult {
  /** The validated policy. */
  policy: ResolvedMultisigPolicy;
  /**
   * The setup transaction, in submission order. It is a single transaction so
   * a partially applied policy is impossible: either every signer and the new
   * thresholds are installed together, or nothing changes. The master key
   * weight change (if any) is the last operation.
   */
  transactions: Transaction[];
  /** The dry-run summary for this setup. */
  dryRun: MultisigDryRun;
}

/** On-chain multisig state read from a Stellar account. */
export interface MultisigOnState {
  account: string;
  signers: MultisigSigner[];
  thresholds: { low: number; medium: number; high: number };
  masterKeyWeight: number;
  totalWeight: number;
}

/** Result of {@link verifyMultisig}. */
export interface MultisigVerificationResult {
  /** Whether the on-chain state matches the intended policy. */
  matches: boolean;
  /** The on-chain state. */
  onState: MultisigOnState;
  /** Human-readable differences between intended and on-chain state. */
  differences: string[];
}

/** Minimal interface for a Horizon server client (subset of `Horizon.Server`). */
export interface HorizonServerLike {
  loadAccount(accountId: string): Promise<Pick<Horizon.AccountResponse, "signers" | "thresholds">>;
}

/** Options for {@link buildMultisigSetup}. */
export interface BuildMultisigSetupOptions extends MultisigPolicy {
  /**
   * Source account used to build the transaction. Defaults to
   * `new Account(policy.account, "0")`, which is enough to inspect or sign a
   * transaction locally but not to submit it — supply an `Account` loaded
   * from Horizon (with its current sequence number) when you intend to
   * submit.
   */
  sourceAccount?: Account;
  /** Network passphrase. Defaults to testnet. */
  networkPassphrase?: string;
  /** Transaction timebound in seconds. Defaults to 300. */
  timeoutSeconds?: number;
  /** Base fee per operation. Defaults to `BASE_FEE`. */
  fee?: string;
}

/** Options for {@link verifyMultisig}. */
export interface VerifyMultisigOptions {
  /** Horizon server client used to load the account. */
  server: HorizonServerLike;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isValidWeight(weight: number): boolean {
  return Number.isInteger(weight) && weight >= MIN_WEIGHT && weight <= MAX_WEIGHT;
}

function isValidThreshold(threshold: number): boolean {
  return Number.isInteger(threshold) && threshold >= 1 && threshold <= MAX_WEIGHT;
}

/** Resolve the optional thresholds and `removeMasterKey` against the defaults. */
export function resolveMultisigPolicy(policy: MultisigPolicy): ResolvedMultisigPolicy {
  return {
    account: policy.account,
    signers: policy.signers.map((s) => ({ ...s })),
    threshold: policy.threshold,
    lowThreshold: policy.lowThreshold ?? policy.threshold,
    mediumThreshold: policy.mediumThreshold ?? policy.threshold,
    highThreshold: policy.highThreshold ?? policy.threshold,
    removeMasterKey: policy.removeMasterKey ?? true,
  };
}

/**
 * Validate a policy without building transactions. Throws on structural errors
 * ({@link MultisigValidationError}) or lock-out configurations
 * ({@link MultisigLockOutError}).
 */
export function validateMultisigPolicy(policy: MultisigPolicy): void {
  const reasons: string[] = [];

  if (!policy.account || typeof policy.account !== "string") {
    reasons.push("account must be a non-empty string");
  }
  if (!Array.isArray(policy.signers) || policy.signers.length === 0) {
    reasons.push("signers must be a non-empty array");
  }
  if (!isValidThreshold(policy.threshold)) {
    reasons.push(`threshold must be an integer in 1..${MAX_WEIGHT}`);
  }
  for (const field of ["lowThreshold", "mediumThreshold", "highThreshold"] as const) {
    const value = policy[field];
    if (value !== undefined && !isValidThreshold(value)) {
      reasons.push(`${field} must be an integer in 1..${MAX_WEIGHT}`);
    }
  }

  const seen = new Set<string>();
  for (const signer of policy.signers ?? []) {
    if (!signer || typeof signer.key !== "string" || signer.key.length === 0) {
      reasons.push("signer key must be a non-empty string");
      continue;
    }
    if (!isValidWeight(signer.weight) || signer.weight === 0) {
      reasons.push(`signer ${signer.key} weight must be an integer in 1..${MAX_WEIGHT}`);
    }
    if (seen.has(signer.key)) {
      reasons.push(`duplicate signer key: ${signer.key}`);
    }
    seen.add(signer.key);
  }

  // Structural problems above make the arithmetic below meaningless.
  if (reasons.length > 0) {
    throw new MultisigValidationError(`Invalid multisig policy: ${reasons.join("; ")}`, reasons);
  }

  const resolved = resolveMultisigPolicy(policy);
  const { lowThreshold, mediumThreshold, highThreshold, removeMasterKey } = resolved;

  const thresholdReasons: string[] = [];
  if (lowThreshold > mediumThreshold || mediumThreshold > highThreshold) {
    thresholdReasons.push(
      `thresholds must satisfy low <= medium <= high (got ${lowThreshold}, ${mediumThreshold}, ${highThreshold})`,
    );
  }

  const masterSigner = resolved.signers.find((s) => s.key === resolved.account);
  if (masterSigner && removeMasterKey) {
    thresholdReasons.push(
      "the account's own key cannot be a signer when removeMasterKey is true; set removeMasterKey: false to keep it",
    );
  }

  const remainingWeight = resolved.signers
    .filter((s) => s.key !== resolved.account)
    .reduce((sum, s) => sum + s.weight, 0);
  const masterKeyWeight = removeMasterKey ? 0 : (masterSigner?.weight ?? 0);
  const totalWeight = remainingWeight + masterKeyWeight;

  // The lock-out check that is the reason this module exists: after the setup
  // the account must still be able to reach its highest threshold.
  if (totalWeight < highThreshold) {
    thresholdReasons.push(
      `sum of signer weights after setup (${totalWeight}) is below the high threshold (${highThreshold}) - the account would be locked out`,
    );
  }

  if (thresholdReasons.length > 0) {
    throw new MultisigLockOutError(
      `Refusing multisig configuration that would lock out ${resolved.account}: ${thresholdReasons.join("; ")}`,
      thresholdReasons,
    );
  }
}

/** Compute the dry-run summary for a policy. Throws if the policy is invalid. */
export function dryRunMultisigSetup(policy: MultisigPolicy): MultisigDryRun {
  validateMultisigPolicy(policy);
  const resolved = resolveMultisigPolicy(policy);
  const { account, signers, lowThreshold, mediumThreshold, highThreshold, removeMasterKey } =
    resolved;

  const masterSigner = signers.find((s) => s.key === account);
  const masterKeyWeight = removeMasterKey ? 0 : (masterSigner?.weight ?? 0);
  const remainingWeight = signers
    .filter((s) => s.key !== account)
    .reduce((sum, s) => sum + s.weight, 0);
  const totalWeight = remainingWeight + masterKeyWeight;

  // One setOptions operation per non-master signer, plus one to zero the master
  // key weight. stellar-sdk accepts exactly one `signer` per setOptions call.
  const signerOperations = signers.filter((s) => s.key !== account).length;
  const operationCount = signerOperations + (removeMasterKey ? 1 : 0);

  const signerLines = signers
    .map((s) => `  - ${s.key} (weight ${s.weight})${s.key === account ? " [master key]" : ""}`)
    .join("\n");

  const summary = [
    `Multisig setup for ${account}`,
    `Thresholds: low=${lowThreshold} medium=${mediumThreshold} high=${highThreshold}`,
    `Signers:\n${signerLines}`,
    `Master key weight after setup: ${masterKeyWeight}`,
    `Remaining signer weight: ${remainingWeight} (total ${totalWeight})`,
    `setOptions operations in the setup transaction: ${operationCount}`,
  ].join("\n");

  return {
    policy: resolved,
    totalWeight,
    remainingWeight,
    masterKeyWeight,
    operationCount,
    summary,
  };
}

// ---------------------------------------------------------------------------
// Setup builder
// ---------------------------------------------------------------------------

/**
 * Build the classic `setOptions` transaction that configures a multisig
 * releaser account. Throws on any configuration that would lock the account
 * out.
 *
 * All `setOptions` operations go into one transaction, so the account is never
 * left in an intermediate state: signers, thresholds and the master key weight
 * change apply atomically. The master key weight change, when requested, is the
 * last operation.
 */
export function buildMultisigSetup(options: BuildMultisigSetupOptions): MultisigSetupResult {
  const { sourceAccount, networkPassphrase, timeoutSeconds, fee, ...policyInput } = options;
  const dryRun = dryRunMultisigSetup(policyInput);
  const policy = dryRun.policy;

  const passphrase = networkPassphrase ?? TESTNET_PASSPHRASE;
  const timeout = timeoutSeconds ?? 300;
  const source = sourceAccount ?? new Account(policy.account, "0");

  const builder = new TransactionBuilder(source, {
    fee: fee ?? BASE_FEE,
    networkPassphrase: passphrase,
  });

  // One operation per additional signer. Thresholds are written on every
  // signer operation: they are idempotent within one transaction and mean the
  // policy is complete even in the degenerate case of a single non-master
  // signer.
  const nonMasterSigners = policy.signers.filter((s) => s.key !== policy.account);
  for (const signer of nonMasterSigners) {
    builder.addOperation(
      Operation.setOptions({
        signer: { ed25519PublicKey: signer.key, weight: signer.weight },
        lowThreshold: policy.lowThreshold,
        // stellar-sdk names this option `medThreshold` (Horizon's
        // `med_threshold`); the policy field keeps the long name.
        medThreshold: policy.mediumThreshold,
        highThreshold: policy.highThreshold,
      }),
    );
  }

  // Zero the master key weight last, after the new signers and thresholds are
  // in place (same transaction, so the ordering is documentary).
  if (policy.removeMasterKey) {
    builder.addOperation(
      Operation.setOptions({
        masterWeight: 0,
        lowThreshold: policy.lowThreshold,
        medThreshold: policy.mediumThreshold,
        highThreshold: policy.highThreshold,
      }),
    );
  }

  const transaction = builder.setTimeout(timeout).build();

  return { policy, transactions: [transaction], dryRun };
}

/** Print a dry-run summary to the console. Returns the summary string. */
export function printMultisigDryRun(dryRun: MultisigDryRun): string {
  // eslint-disable-next-line no-console
  console.log(dryRun.summary);
  return dryRun.summary;
}

// ---------------------------------------------------------------------------
// On-chain verification
// ---------------------------------------------------------------------------

/** Read the on-chain multisig state for an account. */
export async function readOnChainMultisig(
  account: string,
  options: VerifyMultisigOptions,
): Promise<MultisigOnState> {
  const response = await options.server.loadAccount(account);
  const signers: MultisigSigner[] = response.signers.map((s) => ({
    key: s.key,
    weight: s.weight,
  }));
  const masterSigner = signers.find((s) => s.key === account);
  const totalWeight = signers.reduce((sum, s) => sum + s.weight, 0);
  return {
    account,
    signers,
    thresholds: {
      low: response.thresholds.low_threshold,
      medium: response.thresholds.med_threshold,
      high: response.thresholds.high_threshold,
    },
    masterKeyWeight: masterSigner?.weight ?? 0,
    totalWeight,
  };
}

/**
 * Read the on-chain thresholds and signers for an account and report whether
 * they match the intended policy. Does not throw on a mismatch — the caller
 * decides what to do with the report.
 */
export async function verifyMultisig(
  policy: MultisigPolicy,
  options: VerifyMultisigOptions,
): Promise<MultisigVerificationResult> {
  const resolved = resolveMultisigPolicy(policy);
  const onState = await readOnChainMultisig(resolved.account, options);
  const differences: string[] = [];

  const { lowThreshold, mediumThreshold, highThreshold, removeMasterKey } = resolved;

  if (onState.thresholds.high !== highThreshold) {
    differences.push(`high threshold: expected ${highThreshold}, got ${onState.thresholds.high}`);
  }
  if (onState.thresholds.medium !== mediumThreshold) {
    differences.push(
      `medium threshold: expected ${mediumThreshold}, got ${onState.thresholds.medium}`,
    );
  }
  if (onState.thresholds.low !== lowThreshold) {
    differences.push(`low threshold: expected ${lowThreshold}, got ${onState.thresholds.low}`);
  }

  const expectedMasterWeight = removeMasterKey
    ? 0
    : (resolved.signers.find((s) => s.key === resolved.account)?.weight ?? 0);
  if (onState.masterKeyWeight !== expectedMasterWeight) {
    differences.push(
      `master key weight: expected ${expectedMasterWeight}, got ${onState.masterKeyWeight}`,
    );
  }

  const expectedSigners = new Map(resolved.signers.map((s) => [s.key, s.weight] as const));
  const onSigners = new Map(onState.signers.map((s) => [s.key, s.weight] as const));
  for (const [key, weight] of expectedSigners) {
    if (key === resolved.account) continue;
    const actual = onSigners.get(key);
    if (actual === undefined) {
      differences.push(`missing signer ${key} (expected weight ${weight})`);
    } else if (actual !== weight) {
      differences.push(`signer ${key} weight: expected ${weight}, got ${actual}`);
    }
  }
  for (const [key, weight] of onSigners) {
    if (key === resolved.account) continue;
    if (!expectedSigners.has(key)) {
      differences.push(`unexpected signer ${key} (weight ${weight})`);
    }
  }

  return { matches: differences.length === 0, onState, differences };
}
