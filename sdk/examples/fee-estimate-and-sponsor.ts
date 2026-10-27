// Flow: the "prepare then submit" sponsorship path. A releaser *prepares* and
// signs a release transaction but does not pay for it; a separate sponsor
// estimates the cost, checks the transaction is safe to pay for
// (`guardSponsorship`), wraps it in a fee-bump with a hard cap (`feeBump`),
// and submits it. The releaser authorizes the escrow call; the sponsor pays
// the fee.
//
//   npm run build && node examples/fee-estimate-and-sponsor.ts   (from sdk/)
//
// This is the only example that reaches below the SDK to build a raw
// transaction with @stellar/stellar-sdk, because the sponsor needs the
// releaser's *signed XDR* to wrap — exactly what a real relayer would receive.
import { EscrowClient } from "../dist/index.js";
import {
  Address,
  Asset,
  BASE_FEE,
  Operation,
  TransactionBuilder,
  nativeToScVal,
} from "@stellar/stellar-sdk";
import { Api, Server } from "@stellar/stellar-sdk/rpc";
import { AMOUNT, CONTRACT_ID, TOKEN, fundedKeypair, run, step } from "./_shared.ts";

const RPC_URL = "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

run(async () => {
  step("Funding a payer, payee, releaser and an independent sponsor…");
  const [payer, payee, releaser, sponsor] = await Promise.all([
    fundedKeypair(),
    fundedKeypair(),
    fundedKeypair(),
    fundedKeypair(),
  ]);
  const client = new EscrowClient({ contractId: CONTRACT_ID });
  const rpc = new Server(RPC_URL);

  step("Creating an escrow to later release…");
  const { escrowId } = await client.createEscrow({
    payer,
    payee: payee.publicKey(),
    token: TOKEN,
    amount: AMOUNT,
    conditionRef: "example-sponsored-release",
    releaser: releaser.publicKey(),
  });
  console.log(`  escrow #${escrowId} funded`);

  step("Sponsor estimates what the release will cost (simulation only)…");
  const estimate = await client.estimate({
    source: releaser,
    method: "release",
    args: [nativeToScVal(escrowId, { type: "u64" }), new Address(releaser.publicKey()).toScVal()],
  });
  console.log(`  resource ${estimate.resourceFee} + inclusion ${estimate.inclusionFee} = ${estimate.total} stroops`);

  step("Releaser PREPARES and signs the release (but does not pay for it)…");
  const account = await rpc.getAccount(releaser.publicKey());
  const unprepared = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(
      Operation.invokeContractFunction({
        contract: CONTRACT_ID,
        function: "release",
        args: [nativeToScVal(escrowId, { type: "u64" }), new Address(releaser.publicKey()).toScVal()],
      }),
    )
    .setTimeout(120)
    .build();
  const prepared = await rpc.prepareTransaction(unprepared);
  prepared.sign(releaser);
  const signedXdr = prepared.toXDR();

  step("Sponsor guards the transaction before paying for it…");
  const guard = client.guardSponsorship(signedXdr);
  console.log(`  escrow release is sponsorable: ${guard.ok} (invokes ${guard.invokedContracts.join(", ")})`);

  // A plain payment is NOT an escrow call: the guard must refuse it.
  const foreign = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(Operation.payment({ destination: payee.publicKey(), asset: Asset.native(), amount: "1" }))
    .setTimeout(120)
    .build();
  foreign.sign(releaser);
  const foreignGuard = client.guardSponsorship(foreign.toXDR());
  console.log(`  a smuggled payment is sponsorable: ${foreignGuard.ok} (${foreignGuard.reasons[0]})`);

  step("Sponsor fee-bumps the release under a hard cap and SUBMITS it…");
  const { xdr, fee, innerTxHash } = client.feeBump(signedXdr, sponsor, { maxFee: 100_000n });
  console.log(`  fee-bump will charge ${fee} stroops; inner tx ${innerTxHash}`);
  const bumped = TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASE);
  const send = await rpc.sendTransaction(bumped);
  if (send.status === "ERROR") {
    throw new Error(`submission rejected: ${JSON.stringify(send.errorResult)}`);
  }

  // Poll until the inner transaction is applied.
  for (let i = 0; i < 20; i++) {
    const result = await rpc.getTransaction(send.hash);
    if (result.status !== Api.GetTransactionStatus.NOT_FOUND) break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  console.log(`  status: ${await client.getStatus(escrowId)}`); // Released — paid for by the sponsor
});
