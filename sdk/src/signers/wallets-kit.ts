// Stellar Wallets Kit → SDK signer adapter (issue #127).
//
// Import this module only in browser code:
//
//   import { WalletsKitSigner } from "@docforum/escrow-sdk/signers/wallets-kit";
//
// It has **no runtime import** of `@creit.tech/stellar-wallets-kit` (the kit
// is injected), so server bundles never pull wallet code and the package stays
// tree-shakeable. The kit itself is an optional peer dependency.
import type { Signer } from "@stellar/stellar-sdk/contract";
import {
  WALLET_INTERNAL_ERROR,
  WALLET_USER_REJECTED,
  WalletNetworkMismatchError,
  WalletSigningUnsupportedError,
  isUserRejection,
  type WalletError,
} from "./types.js";

/**
 * The structural subset of `StellarWalletsKit` this adapter needs. Injecting
 * it keeps the adapter unit-testable with a fake kit and avoids a hard runtime
 * dependency on the wallet package.
 */
export interface WalletsKitLike {
  /** Currently selected account, or triggers the wallet's account prompt. */
  getAddress(): Promise<{ address: string }>;
  /**
   * The network the *wallet* is on. Wallets that cannot report it may omit
   * this (then a passphrase mismatch can only be caught by the network).
   */
  getNetwork?(): Promise<{ network?: string; networkPassphrase?: string }>;
  signTransaction(xdr: string, opts?: {
    address?: string;
    networkPassphrase?: string;
    path?: string;
  }): Promise<{ signedTxXdr: string; signerAddress?: string }>;
  signAuthEntry?(authEntry: string, opts?: {
    address?: string;
    networkPassphrase?: string;
    path?: string;
  }): Promise<{ signedAuthEntry: string; signerAddress?: string }>;
}

export interface WalletsKitSignerOptions {
  /** `StellarWalletsKit` (or a compatible object) after the user picked a wallet. */
  kit: WalletsKitLike;
  /** The address to sign as. Resolved by `connect()` when omitted there. */
  address?: string;
  /** Network the escrow client is configured for — usually the testnet passphrase. */
  networkPassphrase: string;
  /**
   * Ask the wallet which network it is on before every signature. Default
   * `true`; disable only for a wallet that throws from `getNetwork()`.
   */
  checkNetwork?: boolean;
}

/** A signing outcome: a signature, or a normal "user said no" result. */
export type WalletSignTransactionOutcome =
  | { signedTxXdr: string; signerAddress?: string }
  | ({ signedTxXdr: "" } & { error: WalletError });

/**
 * SEP-43 `Signer` backed by Stellar Wallets Kit.
 *
 * - Network mismatch throws `WalletNetworkMismatchError` (typed) *before* the
 *   wallet is asked to sign.
 * - User rejection is returned as `{ signedTxXdr: "", error: { code: -4 } }`,
 *   matching SEP-43, rather than thrown. Callers can treat it as a normal
 *   cancelled action.
 */
export class WalletsKitSigner implements Signer {
  readonly address: string;
  private readonly kit: WalletsKitLike;
  private readonly networkPassphrase: string;
  private readonly checkNetwork: boolean;

  constructor(options: WalletsKitSignerOptions) {
    if (!options.address) {
      throw new TypeError("WalletsKitSigner requires an address; use WalletsKitSigner.connect() to resolve one.");
    }
    this.kit = options.kit;
    this.address = options.address;
    this.networkPassphrase = options.networkPassphrase;
    this.checkNetwork = options.checkNetwork ?? true;
  }

  /** Resolve the wallet's active address and build the adapter. */
  static async connect(options: Omit<WalletsKitSignerOptions, "address"> & { address?: string }): Promise<WalletsKitSigner> {
    const address = options.address ?? (await options.kit.getAddress()).address;
    return new WalletsKitSigner({ ...options, address });
  }

  /**
   * Throws `WalletNetworkMismatchError` when the wallet is on another network.
   * A wallet that cannot report its network is allowed through.
   */
  async assertNetwork(): Promise<void> {
    if (!this.checkNetwork || !this.kit.getNetwork) return;
    let network: { network?: string; networkPassphrase?: string };
    try {
      network = await this.kit.getNetwork();
    } catch {
      // Some wallets don't implement getNetwork; don't block signing on it.
      return;
    }
    if (network.networkPassphrase) {
      if (network.networkPassphrase !== this.networkPassphrase) {
        throw new WalletNetworkMismatchError({
          expectedNetworkPassphrase: this.networkPassphrase,
          actualNetworkPassphrase: network.networkPassphrase,
          actualNetwork: network.network,
        });
      }
      return;
    }
    const expectedName = /Test SDF Network/i.test(this.networkPassphrase)
      ? "TESTNET"
      : /Public Global Stellar Network/i.test(this.networkPassphrase)
        ? "PUBLIC"
        : undefined;
    if (expectedName && network.network && network.network.toUpperCase() !== expectedName) {
      throw new WalletNetworkMismatchError({
        expectedNetworkPassphrase: this.networkPassphrase,
        actualNetwork: network.network,
      });
    }
  }

  /** SEP-43 transaction signing. User rejection is a returned error, not a throw. */
  signTransaction = async (
    xdr: string,
    opts?: { networkPassphrase?: string; address?: string },
  ): Promise<WalletSignTransactionOutcome> => {
    await this.assertNetwork();
    try {
      const result = await this.kit.signTransaction(xdr, {
        address: opts?.address ?? this.address,
        networkPassphrase: opts?.networkPassphrase ?? this.networkPassphrase,
      });
      return { ...result, signerAddress: result.signerAddress ?? this.address };
    } catch (error) {
      if (isUserRejection(error)) {
        return {
          signedTxXdr: "",
          error: { code: WALLET_USER_REJECTED, message: "The user rejected the request in their wallet." },
        };
      }
      throw error;
    }
  };

  /** SEP-43 auth-entry signing, used by M-of-N approvals. */
  signAuthEntry = async (
    authEntry: string,
    opts?: { networkPassphrase?: string; address?: string },
  ): Promise<{ signedAuthEntry: string; signerAddress?: string; error?: WalletError }> => {
    if (!this.kit.signAuthEntry) throw new WalletSigningUnsupportedError("signAuthEntry");
    await this.assertNetwork();
    try {
      const result = await this.kit.signAuthEntry(authEntry, {
        address: opts?.address ?? this.address,
        networkPassphrase: opts?.networkPassphrase ?? this.networkPassphrase,
      });
      return { ...result, signerAddress: result.signerAddress ?? this.address };
    } catch (error) {
      if (isUserRejection(error)) {
        return {
          signedAuthEntry: "",
          error: { code: WALLET_USER_REJECTED, message: "The user rejected the request in their wallet." },
        };
      }
      const message = error instanceof Error ? error.message : String(error);
      return { signedAuthEntry: "", error: { code: WALLET_INTERNAL_ERROR, message } };
    }
  };
}
