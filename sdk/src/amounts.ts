// Token-aware amount helpers (issue #81, Phase E6).
//
// Escrow amounts are raw `bigint` values in the token's smallest unit, and the
// decimals of a SEP-41 token are not guaranteed to be 7 — XLM and most Stellar
// assets are, arbitrary tokens are not. Converting by hand is how callers end
// up paying 10x or 0.1x the intended amount, so everything here is strict: no
// floats, no exponent notation, no thousands separators, no negatives, and more
// fractional digits than the token supports is rejected instead of rounded.
//
// No network access happens at import time; the default token-info source only
// touches RPC when `getTokenInfo` is awaited.
import {
  Account,
  BASE_FEE,
  Contract,
  StrKey,
  TransactionBuilder,
  scValToNative,
} from "@stellar/stellar-sdk";
import { Api, Server as RpcServer } from "@stellar/stellar-sdk/rpc";
import { NULL_ACCOUNT } from "@stellar/stellar-sdk/contract";

/** Default Soroban testnet RPC, matching `EscrowClient`'s default. */
const TESTNET_RPC_URL = "https://soroban-testnet.stellar.org";
const TESTNET_NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

/**
 * Largest supported decimal count. 38 keeps every token amount inside the
 * contract's `i128` range (which tops out just under 1.7e38) while still
 * rejecting nonsense values such as `255` from a misbehaving contract.
 */
export const MAX_TOKEN_DECIMALS = 38;

/** Thrown for any rejected amount, decimal count or token address. */
export class AmountError extends Error {
  readonly name = "AmountError";
  constructor(message: string) {
    super(message);
  }
}

/** The name used in the SDK documentation; kept as an alias for compatibility. */
export { AmountError as InvalidAmountError };

/** `decimals`, `symbol` and `name` as reported by a SEP-41 token contract. */
export interface TokenInfo {
  decimals: number;
  symbol: string;
  name: string;
}

/**
 * Where `getTokenInfo` reads token metadata from. `EscrowClient.getTokenInfo`
 * and the default `getTokenInfo(token)` call use an RPC-backed source; tests
 * inject their own so no network is needed.
 */
export interface TokenInfoSource {
  getTokenInfo(address: string): Promise<TokenInfo>;
}

function assertDecimals(decimals: number): number {
  if (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0 || decimals > MAX_TOKEN_DECIMALS) {
    throw new AmountError(
      `decimals must be an integer between 0 and ${MAX_TOKEN_DECIMALS}, got ${String(decimals)}.`,
    );
  }
  return decimals;
}

function assertContractAddress(token: string): string {
  if (typeof token !== "string" || !StrKey.isValidContract(token)) {
    throw new AmountError(`token must be a valid contract address (C...), got ${JSON.stringify(token)}.`);
  }
  return token;
}

// Digits, with at most one `.`. A trailing dot (`0.`) and a bare `.` are not
// amounts; a leading dot (`.5`) is, and is normalised to `0.5`.
const AMOUNT_PATTERN = /^(?:\d+(?:\.\d+)?|\.\d+)$/;

/**
 * Converts a decimal string such as `"12.5"` into the token's smallest unit
 * (`125000000n` for 7 decimals). Throws `AmountError` on anything that is not a
 * plain non-negative decimal with at most `decimals` fractional digits.
 */
export function parseAmount(value: string, decimals: number): bigint {
  const scale = assertDecimals(decimals);
  if (typeof value !== "string") {
    throw new AmountError(`amount must be a string, got ${typeof value}.`);
  }
  if (!AMOUNT_PATTERN.test(value)) {
    throw new AmountError(
      `amount ${JSON.stringify(value)} is not a plain decimal number; floats, exponents, thousands separators, signs and whitespace are rejected.`,
    );
  }

  const [whole = "", fraction = ""] = value.split(".");
  if (fraction.length > scale) {
    throw new AmountError(
      `amount ${JSON.stringify(value)} has ${fraction.length} fractional digits, but the token supports ${scale}; it would be rounded.`,
    );
  }

  const integerPart = whole === "" ? "0" : whole;
  const fractionPart = fraction.padEnd(scale, "0");
  return BigInt(`${integerPart}${fractionPart}`);
}

/**
 * Converts a raw `bigint` amount into a normalised decimal string: no trailing
 * fractional zeros, no leading zeros, and no fractional part when it is zero.
 */
export function formatAmount(value: bigint, decimals: number): string {
  const scale = assertDecimals(decimals);
  if (typeof value !== "bigint") {
    throw new AmountError(`amount must be a bigint, got ${typeof value}.`);
  }
  if (value < 0n) {
    throw new AmountError(`amount must not be negative, got ${value.toString()}.`);
  }

  const digits = value.toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale).replace(/0+$/, "");
  return fraction.length > 0 ? `${whole}.${fraction}` : whole;
}

/**
 * Returns the canonical decimal string for `value` — the round-trip target of
 * `formatAmount(parseAmount(value, decimals), decimals)`.
 */
export function normaliseAmount(value: string, decimals: number): string {
  return formatAmount(parseAmount(value, decimals), decimals);
}

/** Cached token metadata, keyed by contract address. */
const tokenInfoCache = new Map<string, TokenInfo>();

/** Drops every cached token metadata entry (used by tests and after reorgs). */
export function clearTokenInfoCache(): void {
  tokenInfoCache.clear();
}

export interface TokenInfoSourceOptions {
  rpcUrl?: string;
  networkPassphrase?: string;
}

/**
 * A `TokenInfoSource` that reads `decimals()`, `symbol()` and `name()` from a
 * SEP-41 contract by simulating view calls against Soroban RPC. Simulation
 * needs no funded source account, so no keypair is involved.
 */
export function rpcTokenInfoSource(options: TokenInfoSourceOptions = {}): TokenInfoSource {
  const rpcUrl = options.rpcUrl ?? TESTNET_RPC_URL;
  const networkPassphrase = options.networkPassphrase ?? TESTNET_NETWORK_PASSPHRASE;
  const server = new RpcServer(rpcUrl);

  const readOne = async (token: string, method: string): Promise<unknown> => {
    const operation = new Contract(token).call(method);
    const transaction = new TransactionBuilder(new Account(NULL_ACCOUNT, "0"), {
      fee: BASE_FEE,
      networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();
    const simulation = await server.simulateTransaction(transaction);
    if (Api.isSimulationError(simulation)) {
      throw new AmountError(`Simulating ${method}() on ${token} failed: ${simulation.error}`);
    }
    return scValToNative(simulation.result!.retval);
  };

  return {
    async getTokenInfo(token: string): Promise<TokenInfo> {
      const decimals = await readOne(token, "decimals");
      const symbol = await readOne(token, "symbol");
      const name = await readOne(token, "name");
      return {
        decimals: Number(decimals),
        symbol: String(symbol),
        name: String(name),
      };
    },
  };
}

/**
 * Reads and caches `decimals`, `symbol` and `name` for `token`. The cache is
 * keyed by contract address, so repeated calls (and the `EscrowClient` method)
 * cost one round of RPC the first time only.
 */
export async function getTokenInfo(
  token: string,
  source: TokenInfoSource = rpcTokenInfoSource(),
): Promise<TokenInfo> {
  const address = assertContractAddress(token);
  const cached = tokenInfoCache.get(address);
  if (cached) return cached;

  const info = await source.getTokenInfo(address);
  const decimals = assertDecimals(Number(info?.decimals));
  const result: TokenInfo = {
    decimals,
    symbol: String(info.symbol),
    name: String(info.name),
  };
  tokenInfoCache.set(address, result);
  return result;
}
