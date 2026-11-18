export interface Options {
  command?: string;
  values: Record<string, string>;
  flags: Set<string>;
}

const FLAG_OPTIONS = new Set(["help", "json", "dry-run", "yes", "allow-mainnet", "from-events"]);
const VALUE_OPTIONS = new Set([
  "contract-id", "rpc-url", "network-passphrase", "signer-file", "signer-env",
  "payee", "token", "amount", "condition-ref", "releaser", "refund-after",
  "escrow-id", "start-ledger", "limit",
]);

/** Parse long options. Secrets are never accepted as option values. */
export function parseArgs(args: string[]): Options {
  const command = args[0]?.startsWith("--") ? undefined : args[0];
  const rest = command ? args.slice(1) : args;
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const [rawName, inline] = arg.slice(2).split("=", 2);
    if (rawName === "secret" || rawName === "secret-key" || rawName === "signer-secret") throw new Error("Secrets cannot be supplied as command-line arguments");
    if (FLAG_OPTIONS.has(rawName!)) {
      if (inline !== undefined) throw new Error(`--${rawName} does not take a value`);
      flags.add(rawName!);
      continue;
    }
    if (!VALUE_OPTIONS.has(rawName!)) throw new Error(`Unknown option --${rawName}`);
    const value = inline ?? rest[++index];
    if (!value || value.startsWith("--")) throw new Error(`Option --${rawName} requires a value`);
    if (/^S[A-Z2-7]{55}$/.test(value)) throw new Error("Secret keys cannot be supplied as command-line arguments");
    values[rawName!] = value;
  }
  return { command, values, flags };
}
