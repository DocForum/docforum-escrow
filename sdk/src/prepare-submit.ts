import { Keypair } from "@stellar/stellar-sdk";
import { type CreateEscrowParams } from "./escrow-types.js";
import { type OnTransactionHash, type TransactionLifecycleOptions } from "./lifecycle.js";

/**
 * Default lifetime of a prepared `create_escrow`, in ledgers (about ten
 * minutes at five seconds a ledger): long enough for a person to approve it in
 * a wallet, short enough that a forgotten prompt cannot be replayed later.
 */
export const PREPARED_TX_TTL_LEDGERS = 120;

/** Default cap for the fee-bump `submitSigned` adds when given a `feeBumpSigner`: 1 XLM. */
export const DEFAULT_SUBMIT_MAX_FEE = 10_000_000n;

/** Like `CreateEscrowParams`, but the payer is just a public key: nothing here signs. */
export interface PrepareCreateEscrowParams extends Omit<CreateEscrowParams, "payer"> {
  /** The payer's public key. Funds are pulled from this account. */
  payer: string;
  /**
   * Transaction source (fee payer and sequence provider). Defaults to `payer`,
   * so a wallet that only signs the envelope is enough. Set it to a different
   * account to have a backend pay the fee; the result then lists the payer in
   * `authSigners` and the payer must sign its auth entry
   * (`EscrowClient.signAuthEntries`) before the envelope is signed.
   */
  source?: string;
  /** How many ledgers the prepared transaction stays valid. Default `PREPARED_TX_TTL_LEDGERS`. */
  validForLedgers?: number;
  /** How many ledgers a separately signed auth entry stays valid. Defaults to `validForLedgers`. */
  authValidForLedgers?: number;
}

/** Options for {@link EscrowClient.submitSigned}: hash pinning and optional fee bump. */
export interface SubmitSignedOptions {
  /**
   * The `hash` returned by `prepare*`. When given, the signed envelope must
   * hash to exactly this, otherwise `SignedTransactionMismatchError` is thrown
   * before anything is submitted. Recommended for any backend that prepares
   * and submits in separate requests.
   */
  expectedHash?: string;
  /** Wrap the signed transaction in a fee-bump paid by this account. */
  feeBumpSigner?: Keypair;
  /** Fee cap for the fee-bump, in stroops. Default `DEFAULT_SUBMIT_MAX_FEE`. */
  maxFee?: bigint;
  /** Base fee per operation for the fee-bump, in stroops. Default: the inner transaction's fee rate. */
  baseFee?: bigint;
  /** Status polls before giving up waiting for the result. Default 30. */
  pollAttempts?: number;
  /**
   * Called with the transaction hash before it is sent, so the caller can
   * persist it first. See `OnTransactionHash`.
   */
  onTransactionHash?: OnTransactionHash;
  /** Per-call overrides for `EscrowClientConfig.transaction` (timeouts, `TRY_AGAIN_LATER` budget). */
  transaction?: TransactionLifecycleOptions;
}

/** Outcome of {@link EscrowClient.submitSigned}. */
export interface SubmitSignedResult {
  /** Hash of the submitted transaction (the fee-bump's, when one was added). */
  txHash: string;
  /** Hash of the inner transaction that executed. Equals `txHash` without a fee-bump. */
  innerTxHash: string;
  /** The new escrow id, when the transaction was a `create_escrow`. */
  escrowId?: bigint;
}

// ---------------------------------------------------------------------------
// Offline prepare for release / refund (issue #59)
// ---------------------------------------------------------------------------

/**
 * Default lifetime of an offline-prepared settlement, in ledgers (about one
 * day): air-gapped and multisig signing is slow. The longer the window, the
 * more likely the escrow's state or the source account's sequence changes
 * first; `submitSigned` detects both.
 */
export const OFFLINE_PREPARED_TX_TTL_LEDGERS = 17_280;

/** Arguments for {@link EscrowClient.prepareRelease} / {@link EscrowClient.prepareRefund}. */
export interface PrepareSettlementParams {
  escrowId: bigint;
  /** The escrow's releaser (a public key; may be a classic multisig account). */
  releaser: string;
  /**
   * Transaction source. Defaults to `releaser`, so the releaser's envelope
   * signature(s) authorize the call and the key never needs to be online.
   * Set another account to pay the fee from a hot key; the releaser then
   * appears in `authSigners` and signs its auth entry with `signAuthEntries`.
   */
  source?: string;
  /** Ledgers the transaction stays valid. Default `OFFLINE_PREPARED_TX_TTL_LEDGERS`. */
  validForLedgers?: number;
  /** Ledgers a separately signed auth entry stays valid. Defaults to `validForLedgers`. */
  authValidForLedgers?: number;
}

// ---------------------------------------------------------------------------
// Fee estimation + sponsorship (issue #70)
// ---------------------------------------------------------------------------
