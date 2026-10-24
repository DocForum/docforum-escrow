// Flow: create a single-releaser escrow, confirm it is Funded, then release
// the funds to the payee.
//
//   npm run build && node examples/create-and-release.ts   (from sdk/)
//
// Fresh payer/payee/releaser keypairs are generated and Friendbot-funded at
// runtime — no secrets anywhere.
import { EscrowClient } from "../dist/index.js";
import { AMOUNT, CONTRACT_ID, TOKEN, fundedKeypair, run, step } from "./_shared.ts";

run(async () => {
  step("Funding fresh payer, payee and releaser keypairs on testnet…");
  const [payer, payee, releaser] = await Promise.all([
    fundedKeypair(),
    fundedKeypair(),
    fundedKeypair(),
  ]);
  const client = new EscrowClient({ contractId: CONTRACT_ID });

  step(`Creating an escrow locking ${AMOUNT} stroops for the payee…`);
  const { escrowId, txHash } = await client.createEscrow({
    payer,
    payee: payee.publicKey(),
    token: TOKEN,
    amount: AMOUNT,
    conditionRef: "example-create-and-release",
    releaser: releaser.publicKey(),
  });
  console.log(`  escrow #${escrowId} funded in tx ${txHash}`);
  console.log(`  status: ${await client.getStatus(escrowId)}`); // Funded

  step("Releasing the escrow to the payee (authorized by the releaser)…");
  const released = await client.release({ escrowId, caller: releaser });
  console.log(`  released in tx ${released.txHash}`);
  console.log(`  status: ${await client.getStatus(escrowId)}`); // Released
});
