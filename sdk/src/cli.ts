#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { emitKeypressEvents } from "node:readline";
import { stdin, stdout } from "node:process";
import { Keypair, rpc } from "@stellar/stellar-sdk";
import { Client } from "./generated/contract-client.js";
import { parseArgs, type Options } from "./cli-args.js";

const TESTNET_RPC = "https://soroban-testnet.stellar.org";
const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const MAINNET_PASSPHRASE = "Public Global Stellar Network ; September 2015";

function output(value: unknown, json: boolean): void {
  if (json) console.log(JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item, 2));
  else if (typeof value === "string") console.log(value);
  else console.log(value);
}

function required(options: Options, name: string): string {
  const value = options.values[name];
  if (!value) throw new Error(`Missing required option --${name}`);
  return value;
}

async function signer(options: Options): Promise<Keypair> {
  const file = options.values["signer-file"];
  const env = options.values["signer-env"];
  if (file && env) throw new Error("Use only one signer source: --signer-file or --signer-env");
  let secret: string | undefined;
  if (file) secret = (await readFile(file, "utf8")).trim();
  else if (env) secret = process.env[env];
  else if (process.env.DOCFORUM_SECRET_KEY) secret = process.env.DOCFORUM_SECRET_KEY;
  else {
    if (!stdin.isTTY || !stdin.setRawMode) throw new Error("No signer configured; set DOCFORUM_SECRET_KEY or use --signer-file");
    secret = await hiddenPrompt();
  }
  if (!secret) throw new Error("Signer secret is empty or unavailable");
  return Keypair.fromSecret(secret);
}

function hiddenPrompt(): Promise<string> {
  return new Promise((resolve, reject) => {
    emitKeypressEvents(stdin);
    stdout.write("Stellar secret key (input hidden): ");
    stdin.setRawMode(true);
    stdin.resume();
    let value = "";
    const cleanup = () => { stdin.setRawMode(false); stdin.pause(); stdin.off("keypress", onKey); };
    const onKey = (chunk: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && key.name === "c") { cleanup(); stdout.write("\n"); reject(new Error("Signer prompt cancelled")); }
      else if (key.name === "return" || key.name === "enter") { cleanup(); stdout.write("\n"); resolve(value); }
      else if (key.name === "backspace") value = value.slice(0, -1);
      else if (chunk && !key.ctrl) value += chunk.replace(/[^\x20-\x7e]/g, "");
    };
    stdin.on("keypress", onKey);
  });
}

async function confirm(options: Options, message: string): Promise<boolean> {
  if (options.flags.has("yes")) return true;
  if (!stdin.isTTY) throw new Error("Confirmation required; pass --yes for a non-interactive run");
  const prompt = createInterface({ input: stdin, output: stdout });
  try { return (await prompt.question(`${message} [y/N] `)).toLowerCase() === "y"; }
  finally { prompt.close(); }
}

async function run(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const json = options.flags.has("json");
  if (options.flags.has("help") || !options.command) {
    const help = `docforum-escrow ${options.command ?? "<create|status|show|release|refund|list>"}\n\nCommon options: --contract-id ID --rpc-url URL --network-passphrase TEXT --json --dry-run\nSigner options: --signer-file PATH, --signer-env NAME, or DOCFORUM_SECRET_KEY (otherwise prompt)\nState changes require confirmation unless --yes is passed. list requires --from-events.`;
    output(help, false);
    return;
  }
  const contractId = required(options, "contract-id");
  const rpcUrl = options.values["rpc-url"] ?? TESTNET_RPC;
  const rpcHost = new URL(rpcUrl).hostname.toLowerCase();
  const mainnetRpc = rpcHost === "soroban.stellar.org" || /mainnet|pubnet/.test(rpcHost);
  const networkPassphrase = options.values["network-passphrase"] ?? (mainnetRpc ? MAINNET_PASSPHRASE : TESTNET_PASSPHRASE);
  if ((mainnetRpc || networkPassphrase === MAINNET_PASSPHRASE) && !options.flags.has("allow-mainnet")) {
    throw new Error("Mainnet is disabled; pass --allow-mainnet to explicitly enable it");
  }
  const dryRun = options.flags.has("dry-run");
  const mutate = ["create", "release", "refund"].includes(options.command);
  if (mutate && !dryRun && !await confirm(options, `Submit ${options.command}?`)) {
    output({ cancelled: true }, json); return;
  }
  const localSigner = mutate ? await signer(options) : undefined;
  const contract = new Client({
    contractId, rpcUrl, networkPassphrase,
    ...(localSigner ? { publicKey: localSigner.publicKey(), signTransaction: localSigner } : {}),
  });

  let result: unknown;
  switch (options.command) {
    case "create": {
      const payer = localSigner!;
      const tx = await contract.create_escrow({
        payer: payer.publicKey(), payee: required(options, "payee"), token: required(options, "token"),
        amount: BigInt(required(options, "amount")), condition_ref: required(options, "condition-ref"),
        releaser: options.values.releaser ?? payer.publicKey(),
        refund_after: options.values["refund-after"] ? BigInt(options.values["refund-after"]) : undefined,
        // The operator CLI only drives plain escrows; the payee-callback and
        // sponsored-refund options stay on the programmatic SDK surface.
        notify_payee: false,
        refund_to: undefined,
      });
      const simulatedId = tx.result.unwrap();
      if (dryRun) result = { simulated: true, escrowId: simulatedId };
      else { const sent = await tx.signAndSend(); result = { escrowId: sent.result.unwrap(), txHash: sent.sendTransactionResponse?.hash }; }
      break;
    }
    case "status": result = (await contract.get_status({ escrow_id: BigInt(required(options, "escrow-id")) })).result.unwrap().tag; break;
    case "show": result = (await contract.get_escrow({ escrow_id: BigInt(required(options, "escrow-id")) })).result.unwrap(); break;
    case "release":
    case "refund": {
      const caller = localSigner!;
      const args = { escrow_id: BigInt(required(options, "escrow-id")), caller: caller.publicKey() };
      const tx = options.command === "release" ? await contract.release(args) : await contract.refund(args);
      tx.result.unwrap();
      if (dryRun) result = { simulated: true, escrowId: args.escrow_id };
      else { const sent = await tx.signAndSend(); result = { escrowId: args.escrow_id, txHash: sent.sendTransactionResponse?.hash }; }
      break;
    }
    case "list": {
      if (!options.flags.has("from-events")) throw new Error("list requires --from-events");
      const server = new rpc.Server(rpcUrl);
      const latestLedger = await server.getLatestLedger();
      const response = await server.getEvents({
        startLedger: Number(options.values["start-ledger"] ?? Math.max(1, latestLedger.sequence - 9_999)),
        filters: [{ type: "contract", contractIds: [contractId] }],
        limit: Number(options.values.limit ?? 100),
      });
      result = response.events;
      break;
    }
    default: throw new Error(`Unknown command: ${options.command}`);
  }
  output(result, json);
}

run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
