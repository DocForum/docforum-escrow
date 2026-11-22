export type Mode = "create" | "release" | "refund" | "status";

export interface ActionInputs {
  mode: Mode;
  contractId: string;
  signerSecret?: string;
  payee?: string;
  token?: string;
  amount?: bigint;
  conditionRef?: string;
  releaser?: string;
  refundAfter?: bigint;
  escrowId?: bigint;
  rpcUrl: string;
  networkPassphrase: string;
}

export const TESTNET_RPC_URL = "https://soroban-testnet.stellar.org";
export const TESTNET_NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
export const MAINNET_NETWORK_PASSPHRASE = "Public Global Stellar Network ; September 2015";

type RawInputs = Record<string, string | undefined>;

function required(raw: RawInputs, name: string): string {
  const value = raw[name]?.trim();
  if (!value) throw new Error(`Missing required input: ${name}`);
  return value;
}

function optional(raw: RawInputs, name: string): string | undefined {
  const value = raw[name]?.trim();
  return value || undefined;
}

function bigintInput(raw: RawInputs, name: string, positive = false): bigint | undefined {
  const value = optional(raw, name);
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a non-negative integer`);
  const parsed = BigInt(value);
  if (positive && parsed <= 0n) throw new Error(`${name} must be greater than zero`);
  return parsed;
}

export function parseInputs(raw: RawInputs): ActionInputs {
  const mode = required(raw, "mode").toLowerCase();
  if (!(["create", "release", "refund", "status"] as string[]).includes(mode)) {
    throw new Error("mode must be one of: create, release, refund, status");
  }
  const result: ActionInputs = {
    mode: mode as Mode,
    contractId: required(raw, "contract-id"),
    signerSecret: optional(raw, "signer-secret"),
    payee: optional(raw, "payee"),
    token: optional(raw, "token"),
    amount: bigintInput(raw, "amount", true),
    conditionRef: optional(raw, "condition-ref"),
    releaser: optional(raw, "releaser"),
    refundAfter: bigintInput(raw, "refund-after"),
    escrowId: bigintInput(raw, "escrow-id"),
    rpcUrl: optional(raw, "rpc-url") ?? TESTNET_RPC_URL,
    networkPassphrase: optional(raw, "network-passphrase") ?? TESTNET_NETWORK_PASSPHRASE,
  };
  if (result.networkPassphrase === MAINNET_NETWORK_PASSPHRASE) {
    throw new Error("Mainnet is not supported by this action; use Stellar testnet");
  }
  if (mode === "create") {
    for (const name of ["payee", "token", "condition-ref", "amount"] as const) {
      if (name === "amount" ? result.amount === undefined : !result[name === "condition-ref" ? "conditionRef" : name]) {
        throw new Error(`Missing required input for create mode: ${name}`);
      }
    }
    if (!result.signerSecret) throw new Error("Missing required input for create mode: signer-secret");
  } else if (mode !== "status") {
    if (!result.signerSecret) throw new Error(`Missing required input for ${mode} mode: signer-secret`);
    if (result.escrowId === undefined) throw new Error(`Missing required input for ${mode} mode: escrow-id`);
  } else if (result.escrowId === undefined) {
    throw new Error("Missing required input for status mode: escrow-id");
  }
  return result;
}
