// Flow: create an escrow with a short `refundAfter` deadline, then — once the
// deadline passes — have a completely unrelated account (a "stranger", not the
// releaser) trigger the refund. This is the lost-releaser-key escape hatch
// (docs/adr/0004): after the deadline anyone may refund, always back to the
// stored refund destination (the payer here).
//
//   npm run build && node examples/timeout-refund.ts   (from sdk/)
import { EscrowClient } from "../dist/index.js";
import { AMOUNT, CONTRACT_ID, TOKEN, fundedKeypair, run, step } from "./_shared.ts";

run(async () => {
  step("Funding fresh payer, payee, releaser and an unrelated stranger…");
  const [payer, payee, releaser, stranger] = await Promise.all([
    fundedKeypair(),
    fundedKeypair(),
    fundedKeypair(),
    fundedKeypair(),
  ]);
  const client = new EscrowClient({ contractId: CONTRACT_ID });

  // A short, future deadline. The contract rejects a deadline already in the
  // past at creation (Error::InvalidRefundAfter), so keep it ahead of now.
  const refundAfter = BigInt(Math.floor(Date.now() / 1000) + 25);

  step(`Creating an escrow that anyone may refund after unix ${refundAfter}…`);
  const { escrowId } = await client.createEscrow({
    payer,
    payee: payee.publicKey(),
    token: TOKEN,
    amount: AMOUNT,
    conditionRef: "example-timeout-refund",
    releaser: releaser.publicKey(),
    refundAfter,
  });
  const escrow = await client.getEscrow(escrowId);
  console.log(`  escrow #${escrowId} status ${escrow.status}, refundAfter ${escrow.refundAfter}`);
  console.log(`  refunds go to refundTo = ${escrow.refundTo} (the payer, since none was set)`);

  step("Waiting for the wall clock to pass the deadline (plus one ledger)…");
  // The contract compares against the ledger close time, so allow a little
  // slack beyond the raw deadline before submitting.
  while (Date.now() / 1000 <= Number(refundAfter) + 6) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  step("A stranger — not the releaser — refunds the timed-out escrow…");
  const refunded = await client.refund({ escrowId, caller: stranger });
  console.log(`  refunded in tx ${refunded.txHash}`);
  console.log(`  status: ${await client.getStatus(escrowId)}`); // Refunded
});
