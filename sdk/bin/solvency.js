#!/usr/bin/env node
import { checkSolvency } from "../dist/solvency.js";

function usage() {
  console.log(`Usage: npx --package @docforum/escrow-sdk docforum-solvency --contract-id <C...> --tokens <C...,C...> [--rpc-url <url>] [--network-passphrase <value>]

Checks escrow token balances against outstanding escrow amounts. Read-only.
Exit codes: 0 solvent and complete; 1 shortfall; 2 incomplete history or error.`);
}

function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    const name = args[i];
    if (name === "--help" || name === "-h") return { help: true };
    if (!["--contract-id", "--tokens", "--rpc-url", "--network-passphrase"].includes(name)) {
      throw new Error(`Unknown option: ${name}`);
    }
    const value = args[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
    i += 1;
    if (name === "--contract-id") options.contractId = value;
    if (name === "--tokens") options.tokens = value.split(",").map((token) => token.trim()).filter(Boolean);
    if (name === "--rpc-url") options.rpcUrl = value;
    if (name === "--network-passphrase") options.networkPassphrase = value;
  }
  if (!options.contractId) throw new Error("--contract-id is required");
  if (!options.tokens?.length) throw new Error("--tokens requires at least one comma-separated token address");
  return options;
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
  } else {
    const report = await checkSolvency(options);
    console.log(JSON.stringify(report, (_, value) => typeof value === "bigint" ? value.toString() : value, 2));
    if (report.tokens.some((token) => !token.complete)) process.exitCode = 2;
    else if (report.tokens.some((token) => token.shortfall > 0n)) process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  usage();
  process.exitCode = 2;
}
