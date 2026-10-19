import {
  Account,
  Keypair,
  Operation,
  TransactionBuilder,
} from "@rogue/stellar-sdk";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/** A configured signer on a multisig account. */
export interface MultisigSigner {
  /** Stellar account id (G31 address) or ed25519 public key (G56 address). */
  publicKey: string;
  /** Signer weight, an integer in [1, 255]. */
  weight: number;
}

/** Threshold policy for a multisig account. */
export interface MultisigThreshold {
  /** Weight needed to submit a transaction. */
  low: number;
  /** Weight needed to sign a transaction (merge into high). */
  medium: number;
  /** Weight needed to change signers/thresholds. */
  high: number;
}

/** Input to {@link buildMultisigSetup}. */
export interface MultisigSetupParams {
  /** The account that will become the multisig releaser. */
  account: string;
  /** The signers to configure. */
  signers: MultisigAuthorizedSigner[];
  /** The target threshold policy. */
  threshold: MultisigThreshold;
  /**
   * Weight to assign to the account's master key as the final step.
   * Defaults to 0 (master key removed) when omitted.
   */
  masterWeight?: number;
}

/** A signer as accepted by the builder (weight optional, defaults to 1). */
export interface MultisigAuthorizedSigner {
  publicKey: string;
  weight?: number;
}

/** Result of {@link buildMultisigSetup}. */
export interface MultisigSetupResult {
  /** The account id the setup is for. */
  account: string;
  /** The normalized signer set. */
  signers: MultisigSigner[];
  /** The validated threshold policy. */
  threshold: MultisigThreshold;
  /** The master key weight applied in the final step. */
  masterWeight: number;
  /**
   * Ordered classic transactions. The master key weight change is always
   * in the last transaction. Submit them in order.
   */
  transactions: TransactionBuilder[];
}

/** Report returned by {@link verifyMultisig}. */
export interface MultisigVerifyReport {
  /** The account id verified. */
  account: string;
  /** Thresholds read from the network. */
  thresholds: MultisigThreshold;
  /** Signers read from the network (including the master key if present). */
  signers: MultisigSigner[];
  /** True when the on-chain state matches the intended policy. */
  matches: boolean;
  /** Human-readable explanation of any mismatch. */
  problems: string[];
}

/** Dry-run summary produced by {@link dryRunMultisigSetup}. */
export interface MultisigDryRunReport {
  account: string;
  threshold: MultisigThreshold;
  signers: MultisigAuthorizedSigner[];
  masterWeight: number;
  /** Sum of all signer weights after setup. */
  totalWeight: number;
  /** Sum of weights excluding the master key. */
  nonMasterWeight: number;
  /** Number of signers whose weight counts toward the high threshold. */
  signerCount: number;
  /** Number of transactions that would be submitted. */
  transactionCount: number;
  /** Rich human-readable summary for CLI output. */
  summary: string;
}

/** Error thrown when a multisig configuration would lock the account out. */
export class MultisigLockoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MultisigLockoutError";
  }
}

/** Error thrown when input to a multisig helper is invalid. */
export class MultisigInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MultisigInputError";
  }
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const MAX_WEIGHT = 255;
const MIN_WEIGHT = 1;
const MAX_SIGNERS = 20;

const THRESHOLD_KEYS: Array<keyof MultisigThreshold> = ["low", "medium", "high"];

// -----------------------------------------------------------------------------
// Validation
// -----------------------------------------------------------------------------

function isValidWeight(weight: unknown): weight is number {
  return (
    typeof weight === "number" &&
    Number.isInteger(weight) &&
    weight >= MIN_WEIGHT &&
    weight <= MAX_WEIGHT
  );
}

function isValidThreshold(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_WEIGHT
  );
}

function normalizeSigners(
  signers: MultisigAuthorizedSigner[],
): MultisigSigner[] {
  if (!Array.isArray(signers) || signers.length === 0) {
    throw new MultisigInputError("signers must be a non-empty array");
  }
  if (signers.length > MAX_SIGNERS) {
    throw new MultisigInputError(
      `signers must contain at most ${MAX_SIGNERS} entries (stellar limit), got ${signers.length}`,
    );
  }

  const seen= new Set<string>();
  const normalized: MultisigSigner[] = [];
  for (const [index, signer] of signers.entries()) {
    if (!signer || typeof signer.publicKey !== "string") {
      throw new MultisigInputError(`signers[${index}] is missing a publicKey`);
    }
    const publicKey = signer.publicKey.trim();
    if (!publicKey) {
      throw new MultisigInputError(`signers[${index}].publicKey is empty`);
    }
    if (!/^G[1-9Q-Z1-9]{56}$/.test(publicKey)) {
      throw new MultisigInputError(
        `signers[${index}].publicKey is not a valid Stellar address: ${publicKey}`,
      );
    }
    if (seen.has(publicKey)) {
      throw new MultisigInputError(`duplicate signer key: ${publicKey}`);
    }
    seen.add(publicKey);

    const weight = signer.weight === undefined ? 1 : signer.weight;
    if (!isValidWeight(weight)) {
      throw new MultisigInputError(
        `signers[${index}].weight must be an integer in [${MIN_WEIGHT}, ${MAX_WEIGHT}], got ${String(weight)}`,
      );
    }
    normalized.push({ publicKey, weight });
  }
  return normalized;
}

function normalizeThreshold(threshold: MultisigThreshold): MultisigThreshold {
  if (!threshold || typeof threshold !== "object") {
    throw new MultisigInputError("threshold must be an object with low/medium/high");
  }
  const out = {} as MultisigThreshold;
  for (const key of THRESHOLD_KEYS) {
    const value = threshold[key];
    if (!isValidThreshold(value)) {
      throw new MultisigInputError(
        `threshold.${key} must be an integer in [0, ${MAX_WEIGHT}], got ${String(value)}`,
      );
    }
    out[key] = value;
  }
  if (out.low > out.medium || out.medium > out.high) {
    throw new MultisigInputError(
      `thresholds must be non-decreasing (low <= medium <= high), got low=${out.low} medium=${out.medium} high=${out.high}`,
    );
  }
  if (out.high < 1) {
    throw new MultisigInputError("threshold.high must be at least 1");
  }
  return out;
}

/**
 * Validate that a signer set + threshold policy can not lock the account out.
 *
 * Rules enforced:
 *  1. The sum of all signer weights must meet or exceed the high threshold.
 *  2. The sum of all signer weights must meet or exceed the medium threshold.
 *  3. The sum of all signer weights must meet or exceed the low threshold.
 *  4. The master key weight must not be the only way to reach the high threshold
 *     unless the caller explicitly retains it (default removal is safe).
 *  5. At least one signer must exist and be able to sign (no all-zero weights).
 */
export function validateMultisigSetup(
  signers: MultisigSigner[],
  threshold: MultisigThreshold,
  masterWeight = 0,
  account?: string,
): void {
  if (signers.length === 0) {
    throw new MultisigLockoutError("no signers configured");
  }
  if (!isValidThreshold(masterWeight) && masterWeight !== 0) {
    throw new MultisigInputError(
      `masterWeight must be 0 or an integer in [${MIN_WEIGHT}, ${MAX_WEIGHT}], got ${String(masterWeight)}`,
    );
  }

  const signerSum = signers.reduce((sum, s) => sum + s.weight, 0);
  const total = signerSum + masterWeight;

  if (signerSum < 1) {
    throw new MultisigLockoutError("sum of signer weights is zero");
  }
  if (total < threshold.high) {
    throw new MultisigLockoutError(
      `sum of remaining signer weights (${total}) is below the high threshold (${threshold.high}): the account would be locked out of changing signers`,
    );
  }
  if (total < threshold.medium) {
    throw new MultisigLockoutError(
      `sum of remaining signer weights (${total}) is below the medium threshold (${threshold.medium})`,
    );
  }
  if (total < threshold.low) {
    throw new MultisigLockoutError(
      `sum of remaining signer weights (${total}) is below the low threshold (${threshold.low})`,
    );
  }

  // The master key must not be the sole signer able to meet the high threshold.
  // This would mean removing it later locks you out, and keeping it means
  // the multisig can be bypassed by a single key.
  if (masterWeight > 0 && signerSum < threshold.high) {
    throw new MultisigLockoutError(
      `master key weight (${masterWeight}) would be needed to reach the high threshold (${threshold.high}): the multisig signers (${signerSum}) are insufficient`,
    );
  }

  // The master key must not be able to meet the high threshold alone.
  if (masterWeight >= threshold.high) {
    throw new MultisigLockoutError(
      `master key weight (${masterWeight}) meets the high threshold (${threshold.high}) alone: the multisig can be bypassed by a single key`,
    );
  }

  if (account !== undefined) {
    const master = signers.find((s) => s.publicKey === account);
    if (master && masterWeight > 0) {
      throw new MultisigInputError(
        `account ${account} appears both as a signer and as the master key; remove it from signers`,
      );
    }
  }
}

// -----------------------------------------------------------------------------
// Builder
// -----------------------------------------------------------------------------

/**
 * Build the classic `setOptions` transaction(s) that configure an account as a
 * multisig releaser.
 *
 * The builder always validates the configuration and refuses lock-out setups.
 * The master key weight change is always issued in the final transaction, after
 * all signers and thresholds are in place.
 *
 * The returned transactions are unsigned and unsubmitted. The caller must
 * sign them with the current master key (or another signer that meets the
 * current high threshold) and submit them in order.
 */
export function buildMultisigSetup(
  params: MultisigSetupParams,
): MultisigSetupResult {
  if (!params || typeof params !== "object") {
    throw new MultisigInputError("params must be an object");
  }
  const { account, signers, threshold, masterWeight = 0 } = params;
  if (typeof account !== "string" || !/^G[1-9Q-Z1-9]{56}$/.test(account.trim())) {
    throw new MultisigInputError(`account is not a valid Stellar address: ${String(account)}`);
  }
  const normalizedSigners = normalizeSigners(signers);
  const normalizedThreshold = normalizeThreshold(threshold);
  validateMultisigSetup(normalizedSigners, normalizedThreshold, masterWeight, account.trim());

  const source = new Account(account.trim());
  const transactions: TransactionBuilder[] = [];

  // Step 1: add all signers and set the target thresholds. This is safe because
  // the master key still has its current weight and can authorize the change.
  const signerOps: Operation[] = [];
  for (const signer of normalizedSigners) {
    signerOps.push(
      Operation.setOptions({
        signer: {
          ed25519PublicKey: signer.publicKey,
          weight: signer.weight,
        },
      }),
    );
  }
  signerOps.push(
    Operation.setOptions({
      lowThreshold: normalizedThreshold.low,
      medThreshold: normalizedThreshold.medium,
      highThreshold: normalizedThreshold.high,
    }),
  );

  const signerTx = new TransactionBuilder(source);
  for (const op of signerOps) {
    signerTx.addOperation(op);
  }
  transactions.push(signerTx);

  // Step 2 (last): adjust the master key weight. This is the only operation in
  // the final transaction so it can never be applied before the signers and
  // thresholds are in place.
  const masterTx = new TransactionBuilder(source);
  masterTx.addOperation(
    Operation.setOptions({
      masterWeight,
    }),
  );
  transactions.push(masterTx);

  return {
    account: account.trim(),
    signers: normalizedSigners,
    threshold: normalizedThreshold,
    masterWeight,
    transactions,
  };
}

/**
 * Produce a human-readable dry-run report for a multisig setup.
 *
 * This does not touch the network. It runs the same validation as {@link buildMultisigSetup}
 * and summarizes the resulting thresholds and weights so an operator can confirm
 * the policy before signing anything.
 */
export function dryRunMultisigSetup(
  params: MultisigSetupParams,
  log: (line: string) => void = () => {},
): MultisigDryRunReport {
  const result = buildMultisigSetup(params);
  const totalWeight = result.signers.reduce((sum, s) => sum + s.weight, 0) + result.masterWeight;
  const nonMasterWeight = result.signers.reduce((sum, s) => sum + s.weight, 0);
  const signerCount = result.signers.filter((s) => s.weight > 0).length;

  const lines: string[] = [];
  lines.push(`Multisig dry run for ${result.account}`);
  lines.push("");
  lines.push("Signers:");
  for (const signer of result.signers) {
    lines.push(`  ${signer.publicKey}  weight=${signer.weight}`);
  }
  if (result.masterWeight > 0) {
    lines.push(`  <master key>  weight=${result.masterWeight}`);
  } else {
    lines.push("  <master key>  weight=0 (removed)");
  }
  lines.push("");
  lines.push("Thresholds:");
  lines.push(`  low=${result.threshold.low}  medium=${result.threshold.medium}  high=${result.threshold.high}`);
  lines.push("");
  lines.push(`Total weight: ${totalWeight}`);
  lines.push(`Non-master weight: ${nonMasterWeight}`);
  lines.push(`Signers with non-zero weight: ${signerCount}`);
  lines.push(`Transactions to submit (master key change last): ${result.transactions.length}`);
  const summary = lines.join("\n");
  for (const line of lines) {
    log(line);
  }

  return {
    account: result.account,
    threshold: result.threshold,
    signers: params.signers,
    masterWeight: result.masterWeight,
    totalWeight,
    nonMasterWeight,
    signerCount,
    transactionCount: result.transactions.length,
    summary,
  };
}

// -----------------------------------------------------------------------------
// Verification
// -----------------------------------------------------------------------------

/** Minimal subset of the Stellar Horizon server used by {@link verifyMultisig}. */
export interface MultisigHorizonServer {
  accounts: () => {
    accountId: () => Promise<{
      thresholds: { low_threshold: number; med_threshold: number; high_threshold: number };
      signers: Array<{ key: string; weight: number }>;
    }>;
  };
}

/** Intended policy to compare against on-chain state. */
export interface MultisigPolicyExpectation {
  threshold: MultisigThreshold;
  signers: MultisigAuthorizedSigner[];
  masterWeight?: number;
}

/**
 * Read the on-chain thresholds and signers for an account and report whether
 * they match the intended policy.
 *
 * When no expected policy is supplied, the report simply describes the
 * current state and flags configurations that look like they could lock the
 * account out or bypass the multisig.
 */
export async function verifyMultisig(
  server: MultisigHorizonServer,
  account: string,
  expected?: MultisigPolicyExpectation,
): Promise<MultisigVerifyReport> {
  if (typeof account !== "string" || !/^G[1-9Q-Z1-9]{56}$/.test(account.trim())) {
    throw new MultisigInputError(`account is not a valid Stellar address: ${String(account)}`);
  }
  const id = account.trim();
  const raw = await server.accounts().accountId(id);
  const thresholds: MultisigThreshold = {
    low: raw.thresholds.low_threshold,
    medium: raw.thresholds.med_threshold,
    high: raw.thresholds.high_threshold,
  };
  const signers: MultisigSigner[] = raw.signers.map((s) => ({ publicKey: s.key, weight: s.weight }));

  const problems: string[] = [];
  const master = signers.find((s) => s.publicKey === id);
  const masterWeight = master ? master.weight : 0;
  const nonMasterSum = signers
    .filter((s) => s.publicKey !== id)
    .reduce((sum, s) => sum + s.weight, 0);

  // Always flag on-chain configurations that are locked out or bypassable.
  if (nonMasterSum < thresholds.high) {
    problems.push(
      `sum of non-master signer weights (${nonMasterSum}) is below the high threshold (${thresholds.high}): account cannot change signers without the master key`,
    );
  }
  if (masterWeight >= thresholds.high) {
    problems.push(
      `master key weight (${masterWeight}) meets the high threshold (${thresholds.high}) alone: the multisig can be bypassed`,
    );
  }

  if (expected) {
    const expectedThreshold = normalizeThreshold(expected.threshold);
    const expectedSigners = normalizeSigners(expected.signers);
    const expectedMasterWeight = expected.masterWeight === undefined ? 0 : expected.masterWeight;
    validateMultisigSetup(expectedSigners, expectedThreshold, expectedMasterWeight, id);

    for (const key of THRESHOLD_KEYS) {
      if (thresholds[key] !== expectedThreshold[key]) {
        problems.push(
          `threshold.${key} is ${thresholds[key]} on-chain but expected ${expectedThreshold[key]}`,
        );
      }
    }

    const onchainBy = new Map<string, number>();
    for (const s of signers) {
      onchainBy.set(s.publicKey, s.weight);
    }
    for (const s of expectedSigners) {
      const actual = onchainBy.has(s.publicKey) ? onchainBy.get(s.publicKey)! : 0;
      if (actual !== s.weight) {
        problems.push(
          `signer ${s.publicKey} has weight ${actual} on-chain but expected ${s.weight}`,
        );
      }
    }
    const expectedSet = new Set(expectedSigners.map((s) => s.publicKey));
    for (const s of signers) {
      if (s.publicKey === id) continue;
      if (!expectedSet.has(s.publicKey)) {
        problems.push(`unexpected signer ${s.publicKey} with weight ${s.weight}`);
      }
    }
    if (masterWeight !== expectedMasterWeight) {
      problems.push(
        `master key weight is ${masterWeight} on-chain but expected ${expectedMasterWeight}`,
      );
    }
  }

  return {
    account: id,
    thresholds,
    signers,
    matches: problems.length === 0,
    problems,
  };
}
