// OFFLINE step 2: sign the prepared transaction. Needs no network, only
// @stellar/stellar-sdk. Run once per signer, each on their own machine.
//
//   SIGNER_SECRET=S... node sign.mjs
//
// Check the printed summary against what you intend to authorize BEFORE
// trusting it: you are signing exactly this transaction hash.
import { readFileSync, writeFileSync } from "node:fs";
import { Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";

const secret = process.env.SIGNER_SECRET;
if (!secret) {
  console.error("Set SIGNER_SECRET (use a testnet key for this example).");
  process.exit(1);
}
const prepared = JSON.parse(readFileSync("prepared.json", "utf8"));
const passphrase = process.env.NETWORK_PASSPHRASE ?? Networks.TESTNET;
const signer = Keypair.fromSecret(secret);

const tx = TransactionBuilder.fromXDR(prepared.xdr, passphrase);
if (tx.hash().toString("hex") !== prepared.hash) {
  console.error("prepared.json is inconsistent: its hash does not match its XDR. Refusing to sign.");
  process.exit(1);
}
console.log(`method:   ${prepared.method}`);
console.log(`escrow:   ${prepared.escrowId}`);
console.log(`source:   ${tx.source}`);
console.log(`sequence: ${tx.sequence}`);
console.log(`expires:  ledger ${tx.ledgerBounds?.maxLedger}`);
console.log(`hash:     ${prepared.hash}`);

tx.sign(signer);
const out = `signed-${signer.publicKey().slice(0, 8)}.xdr`;
writeFileSync(out, tx.toXDR());
console.log(`signed as ${signer.publicKey()} -> ${out}`);
