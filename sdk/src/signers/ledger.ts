// Ledger Stellar app → SDK signer adapter (issue #125).
//
// The Ledger app and its transport are injected. This keeps WebHID, Node HID,
// and Ledger's optional packages out of the SDK's runtime dependency graph.
import { Buffer } from "buffer";
import {
  StrKey,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import type { Signer } from "@stellar/stellar-sdk/contract";
import {
  WALLET_INTERNAL_ERROR,
  WALLET_USER_REJECTED,
  WalletSigningUnsupportedError,
  isUserRejection,
  type WalletError,
} from "./types.js";

export interface LedgerStellarAppLike {
  getPublicKey(path: string, display?: boolean): Promise<{ rawPublicKey: Buffer }>;
  getAppConfiguration(): Promise<{
    version: string;
    hashSigningEnabled: boolean;
    maxDataSize?: number;
  }>;
  signTransaction(path: string, signatureBase: Buffer): Promise<{ signature: Buffer }>;
  signSorobanAuthorization?(path: string, hashIdPreimage: Buffer): Promise<{ signature: Buffer }>;
}

export interface LedgerSignerOptions {
  /** An instance of `@ledgerhq/hw-app-str` constructed with WebHID or Node HID. */
  app: LedgerStellarAppLike;
  /** BIP-32 path, normally `44'/148'/0'` for the first Stellar account. */
  path: string;
  address: string;
  networkPassphrase: string;
  /** Set false only for an older app that cannot report its configuration. */
  checkHashSigning?: boolean;
}

export interface LedgerSignerConnectOptions extends Omit<LedgerSignerOptions, "address"> {
  displayAddress?: boolean;
}

export class LedgerHashSigningDisabledError extends Error {
  readonly name = "LedgerHashSigningDisabledError";
  readonly appVersion: string;

  constructor(appVersion: string) {
    super(
      `Ledger Stellar app ${appVersion} has hash signing disabled. Enable hash signing in the app settings ` +
        "and retry; the SDK never falls back to software signing.",
    );
    this.appVersion = appVersion;
  }
}

export class LedgerSigner implements Signer {
  readonly address: string;
  private readonly app: LedgerStellarAppLike;
  private readonly path: string;
  private readonly networkPassphrase: string;
  private readonly checkHashSigning: boolean;

  constructor(options: LedgerSignerOptions) {
    if (!options.address) throw new TypeError("LedgerSigner requires an address.");
    if (!options.path) throw new TypeError("LedgerSigner requires a BIP-32 path.");
    this.app = options.app;
    this.path = options.path;
    this.address = options.address;
    this.networkPassphrase = options.networkPassphrase;
    this.checkHashSigning = options.checkHashSigning ?? true;
  }

  static async connect(options: LedgerSignerConnectOptions): Promise<LedgerSigner> {
    const { rawPublicKey } = await options.app.getPublicKey(options.path, options.displayAddress ?? false);
    const address = StrKey.encodeEd25519PublicKey(Buffer.from(rawPublicKey));
    return new LedgerSigner({ ...options, address });
  }

  private async assertHashSigning(): Promise<void> {
    if (!this.checkHashSigning) return;
    const config = await this.app.getAppConfiguration();
    if (!config.hashSigningEnabled) throw new LedgerHashSigningDisabledError(config.version);
  }

  async signTransaction(
    envelopeXdr: string,
    _opts?: { networkPassphrase?: string; address?: string },
  ): Promise<{ signedTxXdr: string; signerAddress?: string } | { signedTxXdr: ""; error: WalletError }> {
    await this.assertHashSigning();
    try {
      const transaction = TransactionBuilder.fromXDR(envelopeXdr, this.networkPassphrase);
      const { signature } = await this.app.signTransaction(this.path, transaction.signatureBase());
      transaction.addSignature(this.address, Buffer.from(signature).toString("base64"));
      return { signedTxXdr: transaction.toXDR(), signerAddress: this.address };
    } catch (error) {
      if (isUserRejection(error)) {
        return { signedTxXdr: "", error: { code: WALLET_USER_REJECTED, message: "The user rejected the request on the Ledger device." } };
      }
      throw error;
    }
  }

  async signAuthEntry(
    preimageXdr: string,
    _opts?: { networkPassphrase?: string; address?: string },
  ): Promise<{ signedAuthEntry: string; signerAddress?: string; error?: WalletError }> {
    if (!this.app.signSorobanAuthorization) throw new WalletSigningUnsupportedError("signAuthEntry");
    await this.assertHashSigning();
    try {
      const { signature } = await this.app.signSorobanAuthorization(
        this.path,
        Buffer.from(preimageXdr, "base64"),
      );
      return { signedAuthEntry: Buffer.from(signature).toString("base64"), signerAddress: this.address };
    } catch (error) {
      if (isUserRejection(error)) {
        return { signedAuthEntry: "", error: { code: WALLET_USER_REJECTED, message: "The user rejected the request on the Ledger device." } };
      }
      const message = error instanceof Error ? error.message : String(error);
      return { signedAuthEntry: "", error: { code: WALLET_INTERNAL_ERROR, message } };
    }
  }
}
