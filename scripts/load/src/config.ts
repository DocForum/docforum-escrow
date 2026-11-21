// Configuration for the local-network load test (issue #132).
//
// Local only, by construction: `assertLocalRpc` refuses anything that is
// not a loopback RPC endpoint, so a stray environment variable can never
// point this harness at public testnet (hard rule 4, and the issue's
// explicit "local network only" constraint).

export interface LoadConfig {
  /** Contract id of a local deployment whose allowlist accepts `token`. */
  contractId: string;
  /** SEP-41 token address used for escrows (the local native SAC). */
  token: string;
  rpcUrl: string;
  networkPassphrase: string;
  friendbotUrl: string;
  /** How many escrows to create and settle. */
  escrows: number;
  /** Source/channel accounts: also the concurrency ceiling. */
  channels: number;
  /** Distinct payee accounts, funded by the local Friendbot. */
  payees: number;
  /** Amount per escrow, in stroops. */
  amount: bigint;
  /** Fraction of escrows refunded instead of released (0–1). */
  refundShare: number;
  /** Fail the run when more than this many operations fail. */
  maxFailures: number;
  /** Parallel status reads during post-run verification. */
  verifyConcurrency: number;
  /** Directory for report.json / report.md (default: scripts/load/out). */
  outDir: string;
}

export const DEFAULTS = {
  rpcUrl: "http://localhost:8000/soroban/rpc",
  networkPassphrase: "Standalone Network ; February 2017",
  friendbotUrl: "http://localhost:8000/friendbot",
  escrows: 2_000,
  channels: 20,
  payees: 5,
  amount: 1_000n, // 0.0001 XLM — keeps channel balances comfortable
  refundShare: 0.1,
  maxFailures: 0,
  verifyConcurrency: 10,
  outDir: new URL("../out", import.meta.url).pathname,
} as const;

export const USAGE = `Local-network escrow load test.

Usage:
  npm run load -- --contract-id C... --token C... [options]

Required (or via environment):
  --contract-id <C...>        deployed escrow contract id   (CONTRACT_ID)
  --token <C...>              SEP-41 token to escrow         (TOKEN_ID)

Options:
  --escrows <n>               escrows to create + settle     (default 2000)
  --channels <n>              source/channel accounts        (default 20)
  --payees <n>                payee accounts                 (default 5)
  --amount <stroops>          escrow amount                  (default 1000)
  --refund-share <0..1>       fraction refunded, not released (default 0.1)
  --max-failures <n>          allowed failed operations       (default 0)
  --verify-concurrency <n>    parallel status reads           (default 10)
  --rpc-url <url>             local Soroban RPC               (RPC_URL)
  --network-passphrase <s>    local network passphrase        (NETWORK_PASSPHRASE)
  --friendbot-url <url>       local Friendbot                 (FRIENDBOT_URL)
  --out-dir <path>            report directory                (OUT_DIR)
  --help                      show this message

The RPC URL must be loopback (localhost / 127.0.0.1 / ::1); this harness
refuses to run against public testnet or any remote network.

Every channel account is funded by the local Friendbot and is both the
payer and the escrow's releaser for the escrows it sources, so no escrow
ever needs two sequence numbers from different keys at once.
`;

/** Refuse anything that is not a loopback RPC endpoint. */
export function assertLocalRpc(rpcUrl: string): void {
  let host: string;
  try {
    host = new URL(rpcUrl).hostname;
  } catch {
    throw new Error(`--rpc-url is not a valid URL: ${rpcUrl}`);
  }
  const loopback = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);
  if (!loopback.has(host)) {
    throw new Error(
      `Refusing to run against "${host}": this load test is local-network only ` +
        `(the issue and ARCHITECTURE_ESSENTIALS hard rule 4 both forbid public testnet).`,
    );
  }
}

function parseInteger(name: string, raw: string, min: number, max: number): number {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`--${name} must be a non-negative integer, got "${raw}"`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`--${name} must be between ${min} and ${max}, got "${raw}"`);
  }
  return value;
}

export function parseConfig(argv: string[], env: NodeJS.ProcessEnv = process.env): LoadConfig {
  const cli = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(USAGE);
      process.exit(0);
    }
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument "${arg}" — see --help`);
    }
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq !== -1) {
      cli.set(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for --${body}`);
    }
    cli.set(body, value);
    i += 1;
  }

  const contractId = cli.get("contract-id") ?? env.CONTRACT_ID;
  const token = cli.get("token") ?? env.TOKEN_ID;
  if (!contractId) throw new Error("--contract-id (or CONTRACT_ID) is required");
  if (!token) throw new Error("--token (or TOKEN_ID) is required");

  const rpcUrl = cli.get("rpc-url") ?? env.RPC_URL ?? DEFAULTS.rpcUrl;
  assertLocalRpc(rpcUrl);

  const amountRaw = cli.get("amount") ?? String(DEFAULTS.amount);
  if (!/^\d+$/.test(amountRaw) || BigInt(amountRaw) <= 0n) {
    throw new Error(`--amount must be a positive integer number of stroops, got "${amountRaw}"`);
  }

  const refundShareRaw = cli.get("refund-share") ?? String(DEFAULTS.refundShare);
  const refundShare = Number(refundShareRaw);
  if (!Number.isFinite(refundShare) || refundShare < 0 || refundShare > 1) {
    throw new Error(`--refund-share must be between 0 and 1, got "${refundShareRaw}"`);
  }

  return {
    contractId,
    token,
    rpcUrl,
    networkPassphrase: cli.get("network-passphrase") ?? env.NETWORK_PASSPHRASE ?? DEFAULTS.networkPassphrase,
    friendbotUrl: cli.get("friendbot-url") ?? env.FRIENDBOT_URL ?? DEFAULTS.friendbotUrl,
    escrows: parseInteger("escrows", cli.get("escrows") ?? String(DEFAULTS.escrows), 1, 100_000),
    channels: parseInteger("channels", cli.get("channels") ?? String(DEFAULTS.channels), 1, 500),
    payees: parseInteger("payees", cli.get("payees") ?? String(DEFAULTS.payees), 1, 1_000),
    amount: BigInt(amountRaw),
    refundShare,
    maxFailures: parseInteger("max-failures", cli.get("max-failures") ?? String(DEFAULTS.maxFailures), 0, 100_000),
    verifyConcurrency: parseInteger(
      "verify-concurrency",
      cli.get("verify-concurrency") ?? String(DEFAULTS.verifyConcurrency),
      1,
      200,
    ),
    outDir: cli.get("out-dir") ?? env.OUT_DIR ?? DEFAULTS.outDir,
  };
}
