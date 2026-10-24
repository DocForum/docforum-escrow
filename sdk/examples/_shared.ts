// Shared helpers for the runnable examples. No secrets live here or in any
// example: every keypair is generated at runtime and funded by Friendbot on
// Stellar testnet. Nothing in examples/ ever touches mainnet (hard rule 4).
//
// These in-repo examples import the SDK's local build (`../dist`). In your own
// project you would instead install the package and import it by name:
//
//   import { EscrowClient, Keypair } from "@docforum/escrow-sdk";
//
// Network targets default to the current testnet deployment but can be
// overridden with env vars so an example can be pointed at a fresh redeploy
// without editing code:
//   ESCROW_CONTRACT_ID   the deployed escrow contract (C…)
//   ESCROW_TOKEN         a token in the contract's allowlist (C…); default: native XLM SAC
import { Keypair } from "../dist/index.js";

/**
 * Escrow contract to exercise. Defaults to the deployment recorded in
 * docs/testnet-deployments.md / README.md. Override with ESCROW_CONTRACT_ID
 * when you redeploy.
 */
export const CONTRACT_ID =
  process.env.ESCROW_CONTRACT_ID ?? "CAFI5QOTNLK5OIHEHGGQ7B22RN5IUOFGKKEID2OQCZSCJAQS4FLSS2DR";

/** A token in the contract's allowlist. Defaults to the testnet native XLM SAC. */
export const TOKEN =
  process.env.ESCROW_TOKEN ?? "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

/** Stroops to lock per example escrow: 0.1 XLM — small enough for Friendbot-funded runs. */
export const AMOUNT = 1_000_000n;

/**
 * Generate a fresh Stellar keypair and fund it through testnet Friendbot.
 * Friendbot is rate-limited independently of anything we do, so transient
 * (5xx / 429) responses are retried with backoff; a clear client error is not.
 */
export async function fundedKeypair(): Promise<Keypair> {
  const kp = Keypair.random();
  const url = `https://friendbot.stellar.org?addr=${encodeURIComponent(kp.publicKey())}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url);
      if (res.ok) return kp;
      const detail = await res.text();
      if (res.status < 500 && res.status !== 429) {
        throw new Error(`Friendbot funding failed: ${res.status} ${detail}`);
      }
      if (attempt === 4) {
        throw new Error(`Friendbot funding failed after retries: ${res.status} ${detail}`);
      }
    } catch (error) {
      if (attempt === 4 || (error instanceof Error && error.message.startsWith("Friendbot funding failed:"))) {
        throw new Error(`Friendbot funding failed for ${kp.publicKey()}: ${String(error)}`);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000 * 2 ** attempt));
  }
  throw new Error("Friendbot funding failed after retries");
}

/** Print a labelled step so the example output reads as a narrative. */
export function step(message: string): void {
  console.log(`\n• ${message}`);
}

/** Run an example's `main`, printing a clear banner and exiting non-zero on failure. */
export function run(main: () => Promise<void>): void {
  main()
    .then(() => {
      console.log("\n✓ example finished");
    })
    .catch((error: unknown) => {
      console.error("\n✗ example failed:", error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
