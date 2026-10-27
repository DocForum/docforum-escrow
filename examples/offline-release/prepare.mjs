// ONLINE step 1: build and simulate an unsigned release (or refund).
//
//   ESCROW_CONTRACT_ID=C... node prepare.mjs <escrowId> <releaserPublicKey> [--refund]
//
// Writes prepared.json. No secret key is needed or touched here.
import { writeFileSync } from "node:fs";
import { EscrowClient } from "../../sdk/dist/index.js";

const [escrowId, releaser] = process.argv.slice(2);
const refund = process.argv.includes("--refund");
if (!process.env.ESCROW_CONTRACT_ID || !escrowId || !releaser) {
  console.error("usage: ESCROW_CONTRACT_ID=C... node prepare.mjs <escrowId> <releaserPublicKey> [--refund]");
  process.exit(1);
}

const client = new EscrowClient({ contractId: process.env.ESCROW_CONTRACT_ID });
const params = { escrowId: BigInt(escrowId), releaser };
const prepared = refund ? await client.prepareRefund(params) : await client.prepareRelease(params);

writeFileSync("prepared.json", JSON.stringify({ ...prepared, method: refund ? "refund" : "release", escrowId }, null, 2));
console.log(`prepared ${refund ? "refund" : "release"} for escrow ${escrowId}`);
console.log(`  hash:             ${prepared.hash}`);
console.log(`  valid until ledger ${prepared.validUntilLedger} (about a day)`);
console.log("Copy prepared.json to each signer's offline machine, then run sign.mjs there.");
