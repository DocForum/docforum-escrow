import { Keypair } from "@stellar/stellar-sdk";
import type {
  ClientOptions,
  SignAuthEntry,
  SignAuthEntryLike,
  SignTransaction,
  SignTransactionLike,
} from "@stellar/stellar-sdk/contract";

/** Network details supplied to an external signing implementation. */
export interface SignerOptions {
  networkPassphrase: string;
}

/**
 * Identity and signing operations used by the escrow SDK.
 * Implementations should keep private key material outside this process.
 */
export interface Signer {
  publicKey(): string;
  signTransaction(xdr: string, options: SignerOptions): Promise<string>;
  signAuthEntry?(xdr: string, options: SignerOptions): Promise<string>;
}

/** Existing Keypair callers remain supported alongside pluggable signers. */
export type SignerLike = Keypair | Signer;

export type ContractSignerOptions = Pick<
  ClientOptions,
  "publicKey" | "signTransaction" | "signAuthEntry"
>;

/** Adapt the SDK's simple XDR-in/XDR-out interface to Stellar SDK callbacks. */
export function toContractSigner(
  signer: SignerLike,
  networkPassphrase: string,
): ContractSignerOptions {
  if (signer instanceof Keypair) {
    return { publicKey: signer.publicKey(), signTransaction: signer };
  }

  const address = signer.publicKey();
  const signTransaction: SignTransaction = async (xdr, options) => {
    try {
      const signedTxXdr = await signer.signTransaction(xdr, {
        networkPassphrase: options?.networkPassphrase ?? networkPassphrase,
      });
      if (!signedTxXdr) throw new Error("empty signature");
      return { signedTxXdr, signerAddress: address };
    } catch {
      // Do not forward remote signer errors; they can contain sensitive data.
      throw new Error("The configured signer could not sign the transaction.");
    }
  };

  const signAuthEntry: SignAuthEntry | undefined = signer.signAuthEntry
    ? async (xdr, options) => {
        try {
          const signedAuthEntry = await signer.signAuthEntry!(xdr, {
            networkPassphrase: options?.networkPassphrase ?? networkPassphrase,
          });
          if (!signedAuthEntry) throw new Error("empty signature");
          return { signedAuthEntry, signerAddress: address };
        } catch {
          throw new Error("The configured signer could not sign the authorization entry.");
        }
      }
    : undefined;

  return {
    publicKey: address,
    signTransaction: signTransaction as SignTransactionLike,
    ...(signAuthEntry ? { signAuthEntry: signAuthEntry as SignAuthEntryLike } : {}),
  };
}
