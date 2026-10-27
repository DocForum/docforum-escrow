// Flow: create a 2-of-3 M-of-N releaser escrow (docs/adr/0007), show that a
// single releaser cannot settle it alone, then release it with two approvals.
//
//   npm run build && node examples/quorum-release.ts   (from sdk/)
//
// Note: the escrow contract this points at must be a build that includes the
// quorum entry points. Against a deployment without them, creation reverts —
// point ESCROW_CONTRACT_ID at a quorum-capable deployment.
import { EscrowClient } from "../dist/index.js";
import { AMOUNT, CONTRACT_ID, TOKEN, fundedKeypair, run, step } from "./_shared.ts";

run(async () => {
  step("Funding a payer, a payee and three releasers…");
  const [payer, payee, a, b, c] = await Promise.all([
    fundedKeypair(),
    fundedKeypair(),
    fundedKeypair(),
    fundedKeypair(),
    fundedKeypair(),
  ]);
  const client = new EscrowClient({ contractId: CONTRACT_ID });
  const releasers = [a.publicKey(), b.publicKey(), c.publicKey()];

  step("Creating a 2-of-3 quorum escrow…");
  const { escrowId } = await client.createQuorumEscrow({
    payer,
    payee: payee.publicKey(),
    token: TOKEN,
    amount: AMOUNT,
    conditionRef: "example-quorum-release",
    releasers,
    threshold: 2,
  });
  const escrow = await client.getEscrow(escrowId);
  console.log(`  escrow #${escrowId}: threshold ${escrow.threshold} of ${escrow.releasers.length}`);

  step("One releaser alone cannot settle a quorum escrow — this must fail…");
  try {
    await client.release({ escrowId, caller: a });
    throw new Error("expected a single-releaser release to be rejected");
  } catch (error) {
    console.log(`  rejected as expected: ${error instanceof Error ? error.message : error}`);
  }

  step("Two of the three releasers approve the release together…");
  const released = await client.releaseWithApprovals({ escrowId, approvers: [a, c] });
  console.log(`  released in tx ${released.txHash}`);
  console.log(`  status: ${await client.getStatus(escrowId)}`); // Released
});
