// OPTIONAL, TESTNET ONLY: create a funded 2-of-3 account to use as a releaser.
//
//   node setup-multisig.mjs
//
// Writes multisig.json with the account and three signer secrets. These keys
// are for the demo only; never reuse them or commit them.
import { writeFileSync } from "node:fs";
import { Keypair, Networks, Operation, TransactionBuilder, BASE_FEE } from "@stellar/stellar-sdk";
import { Server } from "@stellar/stellar-sdk/rpc";

const rpc = new Server("https://soroban-testnet.stellar.org");
const account = Keypair.random();
const signers = [Keypair.random(), Keypair.random(), Keypair.random()];

const funded = await fetch(`https://friendbot.stellar.org?addr=${account.publicKey()}`);
if (!funded.ok) throw new Error(`Friendbot failed: ${funded.status}`);

let tx = new TransactionBuilder(await rpc.getAccount(account.publicKey()), { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
  .setTimeout(60);
for (const signer of signers) tx = tx.addOperation(Operation.setOptions({ signer: { ed25519PublicKey: signer.publicKey(), weight: 1 } }));
tx = tx.addOperation(Operation.setOptions({ masterWeight: 0, lowThreshold: 2, medThreshold: 2, highThreshold: 2 })).build();
tx.sign(account);
await rpc.sendTransaction(tx);
await rpc.pollTransaction(tx.hash().toString("hex"), { attempts: 30 });

writeFileSync("multisig.json", JSON.stringify({ account: account.publicKey(), signers: signers.map((s) => ({ public: s.publicKey(), secret: s.secret() })) }, null, 2));
console.log(`2-of-3 account ${account.publicKey()} ready; details in multisig.json`);
