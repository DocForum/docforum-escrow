// ONLINE step 3: merge every signed copy and submit, from any machine.
//
//   ESCROW_CONTRACT_ID=C... node submit.mjs
//
// Merges all signed-*.xdr files in this folder (a single file works too, for a
// single-signature cold key), verifies the hash against prepared.json, checks
// the ledger window and the source sequence, then submits and waits.
import { readFileSync, readdirSync } from "node:fs";
import { EscrowClient, PreparedTransactionExpiredError, StaleSequenceError } from "../../sdk/dist/index.js";

const prepared = JSON.parse(readFileSync("prepared.json", "utf8"));
const signedFiles = readdirSync(".").filter((name) => name.startsWith("signed-") && name.endsWith(".xdr"));
if (!process.env.ESCROW_CONTRACT_ID || signedFiles.length === 0) {
  console.error("Set ESCROW_CONTRACT_ID and put at least one signed-*.xdr here.");
  process.exit(1);
}

const client = new EscrowClient({ contractId: process.env.ESCROW_CONTRACT_ID });
const merged = client.mergeSignatures(signedFiles.map((name) => readFileSync(name, "utf8")));
try {
  const { txHash } = await client.submitSigned(merged, { expectedHash: prepared.hash });
  console.log(`submitted ${signedFiles.length} signature(s): ${txHash}`);
} catch (error) {
  if (error instanceof PreparedTransactionExpiredError) {
    console.error(`Too late: the transaction expired at ledger ${error.validUntilLedger}. Run prepare.mjs again and re-sign.`);
  } else if (error instanceof StaleSequenceError) {
    console.error("The source account sent another transaction first, so this one is dead. Run prepare.mjs again and re-sign.");
  } else {
    throw error;
  }
  process.exit(1);
}
