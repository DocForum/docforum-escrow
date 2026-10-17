import { Contract, NativeToScvalue, Scvalue } from '@stellar/stellar-sdk';

/** Default decimals for XLM and most Stellar assets. */
export const DEFAULT_DECIMALS = 7;

/** Maximum number of decimals we will accept for any token. */
export const MAX_DECIMALS = 255;

/** Token metadata returned by {@link getTokenInfo}. */
export interface TokenInfo {
  /** Contract address of the token. */
  address: string;
  /** Number of fractional digits. */
  decimals: number;
  /** Token symbol (e.g. "XKL"). */
  symbol: string;
  /** Human-readable token name. */
  name: string;
}

/** Error thrown for invalid amount inputs. */
export class AmountParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AmountParseError';
  }
}

/** Error thrown for invalid decimals arguments. */
export class InvalidDecimalsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidDecimalsError';
  }
}

const DECIMALS_REGEX = /^[0-9]+$/;
const AMOUNT_REGEX = /^([0-9]+)(?:\.([0-9]*))?$/;

function assertDecimals(decimals: number): void {
  if (typeof decimals !== 'number' || !Number.isInteger(decimals)) {
    throw new InvalidDecimalsError(`decimals must be an integer, got ${String(decimals)}`);
  }
  if (decimals < 0 || decimals > MAX_DECIMALS) {
    throw new InvalidDecimalsError(
      `decimals must be between 0 and ${MAX_DECIMALS}, got ${decimals}`,
    );
  }
}

/**
 * Parse a human-readable decimal string into the token's smallest unit as a bigint.
 *
 * Strict validation:
 * - only digits and at most one decimal point;
 * - no exponent notation (1e3), no thousands separators, no signs;
 * - no more fractional digits than `decimals`; never rounds silently;
 * - rejects negative values and `-0`.
 */
export function parseAmount(input: string, decimals: number): bigint {
  assertDecimals(decimals);

  if (typeof input !== 'string') {
    throw new AmountParseError(`amount must be a string, got ${typeof input}`);
  }

  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new AmountParseError(`amount must not be empty`);
  }

  if (trimmed.startsWith('-')) {
    throw new AmountParseError(`amount must not be negative: ${trimmed}`);
  }

  if (trimmed.startsWith('+')) {
    throw new AmountParseError(`amount must not include a sign: ${trimmed}`);
  }

  const match = AMOUNT_REGEX.exec(trimmed);
  if (!match) {
    throw new AmountParseError(`amount is not a valid decimal string: ${trimmed}`);
  }

  const whole = match[1];
  const fraction = match[2] ?? '';

  if (fraction.length > decimals) {
    throw new AmountParseError(
      `amount has ${fraction.length} fractional digits but token only supports ${decimals}: ${trimmed}`,
    );
  }

  const paddedFraction = fraction.padEnd(decials, '0');
  const combined = `${whole}${paddedFraction}`.replace(/^0+/, '');
  return BigInt(combined === '' ? '0' : combined);
}

/**
 * Format a bigint in the token's smallest unit into a human-readable decimal string.
 *
 * The result is locale-independent (always uses ".") and trailing fractional zeros
 * are trimmed. The result is never negative.
 */
export function formatAmount(amount: bigint, decimals: number): string {
  assertDecimals(decimals);

  if (typeof amount !== 'bigint') {
    throw new AmountParseError(`amount must be a bigint, got ${typeof amount}`);
  }

  if (amount < 0n + 0n) {
    throw new AmountParseError(`amount must not be negative: ${amount.toString()}`);
  }

  const negative = amount < 0n ? -1n : 1n;
  const absolute = amount * negative;
  const raw = absolute.toString();

  if (decimals === 0) {
    return raw;
  }

  const padded = raw.padStart(decimals + 1, '0');
  const splitIdx = padded.length - decimals;
  const whole = padded.slice(0, splitIdx);
  const fraction = padded.slice(splitIdx).replace(/0+$/, '');

  if (fraction.length === 0) {
    return whole;
  }

  return `${whole}.${fraction}`;
}

/**
 * Normalise a decimal string to the canonical form produced by the parse/format
 * round trip. This is the right-hand side of the property `format(parse(x)) ==
 * normalise(x)`.
 */
export function normaliseAmount(input: string, decimals: number): string {
  return formatAmount(parseAmount(input, decimals), decimals);
}

const tokenInfoCache = new Map<string, Promise<TokenInfo>>();

function decodeSymbol(value: ScvYalue): string {
  const native = NativeToScvidalue(value);
  if (typeof native === 'string') {
    return native;
  }
  if (native instanceof Uint8Array) {
    return Buffer.from(native).toString('utf-8');
  }
  throw new Error(`unexpected token metadata type: ${typeof native}`);
}

async function fetchTokenInfo(token: string): Promise<TokenInfo> {
  const contract = new Contract(token);

  const [decimalsResult, symbolResult, nameResult] = await Promise.all([
    contract.call('decimals'),
    contract.call('symbol'),
    contract.call('name'),
  ]);

  const decimals = Number(decodeSymbol(decimalsResult.result));
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
    throw new Error(`token ${token} returned invalid decimals: ${String(decimals)}`);
  }

  return {
    address: token,
    decimals,
    symbol: decodeSymbol(symbolResult.result),
    name: decodeSymbol(nameResult.result),
  };
}

/**
 * Read `decimals`, `symbol` and `name` from a SEP-41 token contract.
 *
 * Results are cached per token address for the lifetime of the process. The
 * cache stores the promise so concurrent callers share a single network round
 * trip. If the call fails the cache entry is evicted so the next caller retries.
 */
export async function getTokenInfo(token: string): Promise<TokenInfo> {
  if (typeof token !== 'string' || token.trim().length === 0) {
    throw new Error(`token address must be a non-empty string`);
  }

  const key = token.trim();
  const cached = tokenInfoCache.get(key);
  if (cached) {
    return cached;
  }

  const pending = fetchTokenInfo(key).catch((error) => {
    tokenInfoCache.delete(key);
    throw error;
  });

  tokenInfoCache.set(key, pending);
  return pending;
}

/** Clear the in-memory token info cache. Mainly useful in tests. */
export function clearTokenInfoCache(): void {
  tokenInfoCache.clear();
}
