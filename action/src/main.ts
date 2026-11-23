import * as core from "@actions/core";
import * as github from "@actions/github";
import { EscrowClient, Keypair } from "../../sdk/src/index.js";
import { parseInputs } from "./inputs.js";

function refuseForkPullRequest(): void {
  if (github.context.eventName !== "pull_request") return;
  const pullRequest = github.context.payload.pull_request;
  const head = pullRequest?.head?.repo?.full_name;
  const base = pullRequest?.base?.repo?.full_name;
  if (head && base && head !== base) {
    throw new Error("Refusing to run with secrets on pull_request events from forks");
  }
}

function rawInputs(): Record<string, string | undefined> {
  const names = ["mode", "contract-id", "signer-secret", "payee", "token", "amount", "condition-ref", "releaser", "refund-after", "escrow-id", "rpc-url", "network-passphrase"];
  return Object.fromEntries(names.map((name) => [name, core.getInput(name)]));
}

async function run(): Promise<void> {
  refuseForkPullRequest();
  const inputs = parseInputs(rawInputs());
  if (inputs.signerSecret) core.setSecret(inputs.signerSecret);
  const client = new EscrowClient({
    contractId: inputs.contractId,
    rpcUrl: inputs.rpcUrl,
    networkPassphrase: inputs.networkPassphrase,
    verifyNetwork: true,
  });

  if (inputs.mode === "status") {
    const status = await client.getStatus(inputs.escrowId!);
    core.setOutput("escrow-id", inputs.escrowId!.toString());
    core.setOutput("status", status);
    return;
  }

  const signer = Keypair.fromSecret(inputs.signerSecret!);
  if (inputs.mode === "create") {
    const created = await client.createEscrow({
      payer: signer,
      payee: inputs.payee!,
      token: inputs.token!,
      amount: inputs.amount!,
      conditionRef: inputs.conditionRef!,
      releaser: inputs.releaser ?? signer.publicKey(),
      refundAfter: inputs.refundAfter,
    });
    core.setOutput("escrow-id", created.escrowId.toString());
    core.setOutput("tx-hash", created.txHash);
    core.setOutput("payer", signer.publicKey());
    core.setOutput("status", "Funded");
    return;
  }

  const settled = inputs.mode === "release"
    ? await client.release({ escrowId: inputs.escrowId!, caller: signer })
    : await client.refund({ escrowId: inputs.escrowId!, caller: signer });
  core.setOutput("escrow-id", inputs.escrowId!.toString());
  core.setOutput("tx-hash", settled.txHash);
  core.setOutput("status", inputs.mode === "release" ? "Released" : "Refunded");
}

run().catch((error: unknown) => core.setFailed(error instanceof Error ? error.message : String(error)));
