// Shared signer types for browser integrations (issue #127).
//
// The SDK's signer surface is `@stellar/stellar-sdk`'s SEP-43 `Signer`:
// something with an `address` and a `signTransaction` callback. A local
// `Keypair` is accepted anywhere a `Signer` is, so server users keep working
// without importing any wallet code.
import type { Keypair } from "@stellar/stellar-sdk";
import type { Signer } from "@stellar/stellar-sdk/contract";

/**
 * Anything the SDK can use to sign: a local `Keypair` (Node/scripts) or a
 * SEP-43 `Signer` (browser wallets, smart accounts, hardware).
 */
export type EscrowSigner = Keypair | Signer;

/** The address an `EscrowSigner` signs as. */
export function signerAddress(signer: EscrowSigner): string {
  const withAddress = signer as { address?: unknown };
  if (typeof withAddress.address === "string") return withAddress.address;
  return (signer as Keypair).publicKey();
}

/**
 * True when a wallet rejected the request. SEP-43 uses error code `-4` for
 * user rejection; wallets are not perfectly consistent, so the message is
 * checked too.
 */
export function isUserRejection(error: unknown): boolean {
  if (!error) return false;
  const code = typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  if (code === -4) return true;
  const name = typeof error === "object" && error !== null && "name" in error
    ? String((error as { name: unknown }).name)
    : "";
  // `@stellar/stellar-sdk`'s AssembledTransaction throws `UserRejectedError`
  // (whose `name` is the generic "Error"), so the message check below is the
  // backstop; this catches adapters that set the class name explicitly.
  if (name === "UserRejected" || name === "UserRejectedError") return true;
  const message = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : typeof error === "object" && error !== null && "message" in error
        ? String((error as { message: unknown }).message)
        : "";
  return /user\s+(rejected|declined|denied|cancell?ed)|rejected\s+by\s+(the\s+)?user|request\s+(was\s+)?(rejected|declined|cancell?ed)/i.test(message);
}

/** SEP-43-shaped wallet error returned as a normal signing outcome. */
export interface WalletError {
  message: string;
  code: number;
}

/** SEP-43 user-rejection code. */
export const WALLET_USER_REJECTED = -4;

/** SEP-43 internal error code used for anything else the wallet reports. */
export const WALLET_INTERNAL_ERROR = -1;

/** The wallet is on a different network than the escrow client. */
export class WalletNetworkMismatchError extends Error {
  readonly name = "WalletNetworkMismatchError";
  readonly expectedNetworkPassphrase: string;
  readonly actualNetworkPassphrase: string | undefined;
  readonly actualNetwork: string | undefined;

  constructor(input: {
    expectedNetworkPassphrase: string;
    actualNetworkPassphrase?: string;
    actualNetwork?: string;
  }) {
    const actual = input.actualNetworkPassphrase ?? input.actualNetwork ?? "unknown";
    super(
      `Wallet is on "${actual}" but this escrow client expects "${input.expectedNetworkPassphrase}". ` +
        "Switch the wallet's network before signing — signing a testnet transaction on mainnet (or vice versa) is never safe.",
    );
    this.expectedNetworkPassphrase = input.expectedNetworkPassphrase;
    this.actualNetworkPassphrase = input.actualNetworkPassphrase;
    this.actualNetwork = input.actualNetwork;
  }
}

/** The selected wallet does not implement a required SEP-43 method. */
export class WalletSigningUnsupportedError extends Error {
  readonly name = "WalletSigningUnsupportedError";
  constructor(method: "signTransaction" | "signAuthEntry") {
    super(`The selected wallet does not implement ${method}. Pick a wallet that supports it.`);
  }
}
