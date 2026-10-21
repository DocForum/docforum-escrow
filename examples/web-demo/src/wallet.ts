// Wallet glue for the browser demo. This is the only file that imports
// Stellar Wallets Kit — the SDK itself has no runtime dependency on it.
import { Networks, StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";
import { defaultModules } from "@creit.tech/stellar-wallets-kit/modules/utils";
import { WalletsKitSigner } from "@docforum/escrow-sdk/signers/wallets-kit";

StellarWalletsKit.init({
  modules: defaultModules(),
  network: Networks.TESTNET,
});

/**
 * Connect the user's wallet and wrap it as an SDK signer.
 * A network mismatch throws `WalletNetworkMismatchError` before signing;
 * a user rejection while signing resolves as `{ status: "rejected" }` in
 * `useEscrowActions`.
 */
export async function connectWallet(walletId?: string): Promise<WalletsKitSigner> {
  if (walletId) StellarWalletsKit.setWallet(walletId);
  return WalletsKitSigner.connect({
    kit: StellarWalletsKit,
    networkPassphrase: Networks.TESTNET,
  });
}
