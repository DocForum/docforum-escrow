import { Buffer } from "buffer";
import { Keypair, TransactionBuilder, hash } from "@stellar/stellar-sdk";
import type {
  SignAuthEntry as StellarSignAuthEntry,
  SignTransaction as StellarSignTransaction,
  Signer as StellarSigner,
} from "@stellar/stellar-sdk/contract";

/** Network context supplied to every signing operation. */
export interface SignerOptions {
  networkPassphrase: string;
  address: string;
}

/** A transport-independent signer for account, wallet, KMS, or HSM backends. */
export interface Signer {
  /** Returns the Stellar public key associated with this signer. */
  publicKey(): string;
  /** Signs a transaction XDR and returns the signed transaction XDR. */
  signTransaction(xdr: string, opts: SignerOptions): Promise<string>;
  /** Signs a Soroban authorization entry when the backend supports it. */
  signAuthEntry?(authEntry: string, opts: SignerOptions): Promise<string>;
}

/** A safe, typed wrapper for failures raised by an external signing backend. */
export class SignerError extends Error {
  readonly operation: "transaction" | "auth-entry";
  override readonly cause?: unknown;

  constructor(operation: "transaction" | "auth-entry", cause?: unknown) {
    super(`Signer failed while signing a ${operation}.`);
    this.name = "SignerError";
    this.operation = operation;
    this.cause = cause;
  }
}

export function isPluggableSigner(value: unknown): value is Signer {
  return typeof value === "object" && value !== null &&
    typeof (value as { publicKey?: unknown }).publicKey === "function" &&
    typeof (value as { signTransaction?: unknown }).signTransaction === "function";
}

function checkNetwork(opts: SignerOptions, expected: string, operation: "transaction" | "auth-entry"): void {
  if (opts.networkPassphrase !== expected) {
    throw new SignerError(operation, new Error("network passphrase mismatch"));
  }
}

/** Adapts a local Keypair to the pluggable signer surface. */
export class KeypairSigner implements Signer {
  constructor(
    private readonly keypair: Keypair,
    private readonly networkPassphrase: string,
  ) {}

  /** Returns the public key of the wrapped keypair. */
  publicKey(): string {
    return this.keypair.publicKey();
  }

  /** Signs a transaction after checking that it targets the configured network. */
  async signTransaction(xdr: string, opts: SignerOptions): Promise<string> {
    try {
      checkNetwork(opts, this.networkPassphrase, "transaction");
      const transaction = TransactionBuilder.fromXDR(xdr, this.networkPassphrase);
      transaction.sign(this.keypair);
      return transaction.toXDR();
    } catch (error) {
      if (error instanceof SignerError) throw error;
      throw new SignerError("transaction", error);
    }
  }

  /** Signs an authorization entry after checking the configured network. */
  async signAuthEntry(authEntry: string, opts: SignerOptions): Promise<string> {
    try {
      checkNetwork(opts, this.networkPassphrase, "auth-entry");
      return this.keypair.sign(hash(Buffer.from(authEntry, "base64"))).toString("base64");
    } catch (error) {
      if (error instanceof SignerError) throw error;
      throw new SignerError("auth-entry", error);
    }
  }
}

/** Endpoint and request options for a remote signing service. */
export interface RemoteSignerOptions {
  url: string;
  publicKey: string;
  headers?: Record<string, string>;
  /** Optional fetch implementation for custom runtimes and tests. */
  fetch?: typeof fetch;
}

/** Small reference HTTP adapter; the endpoint must never receive a secret key. */
export class RemoteSigner implements Signer {
  private readonly request: typeof fetch;

  constructor(private readonly options: RemoteSignerOptions) {
    this.request = options.fetch ?? globalThis.fetch;
    if (typeof this.request !== "function") {
      throw new TypeError("RemoteSigner requires fetch or a runtime with fetch.");
    }
  }

  /** Returns the public key configured for the remote signer. */
  publicKey(): string {
    return this.options.publicKey;
  }

  /** Requests a remote signature for transaction XDR. */
  signTransaction(xdr: string, opts: SignerOptions): Promise<string> {
    return this.requestSigning("transaction", xdr, opts);
  }

  /** Requests a remote signature for a Soroban authorization entry. */
  signAuthEntry(authEntry: string, opts: SignerOptions): Promise<string> {
    return this.requestSigning("auth-entry", authEntry, opts);
  }

  private async requestSigning(
    kind: "transaction" | "auth-entry",
    payload: string,
    opts: SignerOptions,
  ): Promise<string> {
    try {
      const response = await this.request(this.options.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.options.headers },
        body: JSON.stringify({
          kind,
          xdr: payload,
          networkPassphrase: opts.networkPassphrase,
          publicKey: this.publicKey(),
        }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json() as { signedXdr?: unknown };
      if (typeof body.signedXdr !== "string" || body.signedXdr.length === 0) {
        throw new Error("invalid signing response");
      }
      return body.signedXdr;
    } catch (error) {
      if (error instanceof SignerError) throw error;
      throw new SignerError(kind, error);
    }
  }
}

/** Converts the SDK signer to the callback shape expected by Stellar bindings. */
export function toStellarSigner(signer: Signer, networkPassphrase: string): StellarSigner {
  const address = signer.publicKey();
  const signTransaction: StellarSignTransaction = async (xdr, opts) => {
    try {
      return {
        signedTxXdr: await signer.signTransaction(xdr, {
          networkPassphrase: opts?.networkPassphrase ?? networkPassphrase,
          address: opts?.address ?? address,
        }),
        signerAddress: address,
      };
    } catch (error) {
      if (error instanceof SignerError) throw error;
      throw new SignerError("transaction", error);
    }
  };
  const signAuthEntry: StellarSignAuthEntry | undefined = signer.signAuthEntry
    ? async (authEntry, opts) => {
      try {
        return {
          signedAuthEntry: await signer.signAuthEntry!(authEntry, {
            networkPassphrase: opts?.networkPassphrase ?? networkPassphrase,
            address: opts?.address ?? address,
          }),
          signerAddress: address,
        };
      } catch (error) {
        if (error instanceof SignerError) throw error;
        throw new SignerError("auth-entry", error);
      }
    }
    : undefined;
  return { address, signTransaction, signAuthEntry };
}
