import { beforeEach, describe, it, expect } from 'vitest';
import {
  parseAmount,
  formatAmount,
  normaliseAmount,
  getTokenInfo,
  clearTokenInfoCache,
  AmountError,
  type TokenInfo,
  type TokenInfoSource,
} from '../src/amounts.js';

const DECIMALS_XLM = 7;
const DECIMALS_USDC = 6;
const DECIMALS_ZERO = 0;
const DECIMALS_HIGH = 18;

// Real contract strkeys (encoded from 32-byte payloads) so address validation
// exercises the same check callers hit.
const TOKEN_A = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526';
const TOKEN_B = 'CABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAFNSZ';

describe('parseAmount', () => {
  it('parses whole numbers', () => {
    expect(parseAmount('12', DECIMALS_XLM)).toBe(120000000n);
    expect(parseAmount('0', DECIMALS_XLM)).toBe(0n);
  });

  it('parses fractional amounts', () => {
    expect(parseAmount('12.5', DECIMALS_XLM)).toBe(125000000n);
    expect(parseAmount('0.0000001', DECIMALS_XLM)).toBe(1n);
    expect(parseAmount('0.00001', DECIMALS_USDC)).toBe(10n);
  });

  it('parses leading dot amounts', () => {
    expect(parseAmount('.5', DECIMALS_XLM)).toBe(5000000n);
    expect(parseAmount('12', DECIMALS_XLM)).toBe(120000000n);
  });

  it('parses with zero decimals', () => {
    expect(parseAmount('123', DECIMALS_ZERO)).toBe(123n);
    expect(() => parseAmount('1.5', DECIMALS_ZERO)).toThrow(AmountError);
  });

  it('parses very large amounts', () => {
    expect(parseAmount('1000000000000000000000', DECIMALS_HIGH)).toBe(
      1000000000000000000000000000000000000000n,
    );
  });

  it('rejects excess precision instead of rounding', () => {
    expect(() => parseAmount('0.00000001', DECIMALS_XLM)).toThrow(AmountError);
    expect(() => parseAmount('1.12345678', DECIMALS_XLM)).toThrow(AmountError);
  });

  it('rejects float and exponent notation', () => {
    expect(() => parseAmount('1e3', DECIMALS_XLM)).toThrow(AmountError);
    expect(() => parseAmount('1e-3', DECIMALS_XLM)).toThrow(AmountError);
    expect(() => parseAmount('1E3', DECIMALS_XLM)).toThrow(AmountError);
  });

  it('rejects negative amounts, including -0', () => {
    expect(() => parseAmount('-1', DECIMALS_XLM)).toThrow(AmountError);
    expect(() => parseAmount('-0', DECIMALS_XLM)).toThrow(AmountError);
    expect(() => parseAmount('-0.0', DECIMALS_XLM)).toThrow(AmountError);
  });

  it('rejects thousands separators and whitespace', () => {
    expect(() => parseAmount('1,234', DECIMALS_XLM)).toThrow(AmountError);
    expect(() => parseAmount('1 23', DECIMALS_XLM)).toThrow(AmountError);
    expect(() => parseAmount(' 12', DECIMALS_XLM)).toThrow(AmountError);
    expect(() => parseAmount('12.5 ', DECIMALS_XLM)).toThrow(AmountError);
  });

  it('rejects malformed inputs', () => {
    for (const bad of ['', '.', '1.2.3', 'abc', '12.5a', '+.', '+', '0.']) {
      expect(() => parseAmount(bad, DECIMALS_XLM)).toThrow(AmountError);
    }
  });

  it('rejects invalid decimals', () => {
    for (const bad of [-1, 1.5, NaN, Infinity, 255]) {
      expect(() => parseAmount('1', bad)).toThrow(AmountError);
    }
  });

  it('normalises leading zeros and trailing fraction zeros', () => {
    expect(parseAmount('0012.500', DECIMALS_XLM)).toBe(125000000n);
  });
});

describe('formatAmount', () => {
  it('formats whole amounts', () => {
    expect(formatAmount(120000000n, DECIMALS_XLM)).toBe('12');
    expect(formatAmount(0n, DECIMALS_XLM)).toBe('0');
  });

  it('formats fractional amounts', () => {
    expect(formatAmount(125000000n, DECIMALS_XLM)).toBe('12.5');
    expect(formatAmount(1n, DECIMALS_XLM)).toBe('0.0000001');
    expect(formatAmount(1n, DECIMALS_USDC)).toBe('0.000001');
  });

  it('formats with zero decimals', () => {
    expect(formatAmount(123n, DECIMALS_ZERO)).toBe('123');
  });

  it('rejects negative values', () => {
    expect(() => formatAmount(-1n, DECIMALS_XLM)).toThrow(AmountError);
  });

  it('rejects non-bigint values', () => {
    expect(() => formatAmount(12 as unknown as bigint, DECIMALS_XLM)).toThrow(AmountError);
    expect(() => formatAmount(1.5 as unknown as bigint, DECIMALS_XLM)).toThrow(AmountError);
  });

  it('rejects invalid decimals', () => {
    for (const bad of [-1, 1.5, NaN, Infinity, 255]) {
      expect(() => formatAmount(1n, bad)).toThrow(AmountError);
    }
  });
});

describe('normaliseAmount', () => {
  it('strips leading zeros and trailing fraction zeros', () => {
    expect(normaliseAmount('0012.500', DECIMALS_XLM)).toBe('12.5');
    expect(normaliseAmount('0.0000000', DECIMALS_XLM)).toBe('0');
    expect(normaliseAmount('.5', DECIMALS_XLM)).toBe('0.5');
  });

  it('rejects excess precision', () => {
    expect(() => normaliseAmount('0.00000001', DECIMALS_XLM)).toThrow(AmountError);
  });
});

describe('property: format(parse(x)) == normalise(x)', () => {
  const decimalSets = [DECIMALS_ZERO, DECIMALS_USDC, DECIMALS_XLM, DECIMALS_HIGH];

  const randomInt = (max: number): number => Math.floor(Math.random() * (max + 1));

  const randomDigits = (length: number): string => {
    let out = '';
    for (let i = 0; i < length; i++) {
      out += String(randomInt(9));
    }
    return out;
  };

  const randomAmountString = (decimals: number): string => {
    const integerLen = randomInt(6);
    const integerPart = integerLen === 0 ? '0' : randomDigits(integerLen);
    const fracLen = decimals === 0 ? 0 : randomInt(decimals);
    const fracPart = fracLen > 0 ? randomDigits(fracLen) : '';
    return fracPart ? `${integerPart}.${fracPart}` : integerPart;
  };

  it('holds for random valid inputs across decimal sets', () => {
    for (let iter = 0; iter < 500; iter++) {
      const decimals = decimalSets[randomInt(decimalSets.length - 1)];
      const input = randomAmountString(decimals);
      const parsed = parseAmount(input, decimals);
      const formatted = formatAmount(parsed, decimals);
      const normalised = normaliseAmount(input, decimals);
      expect(formatted).toBe(normalised);
      expect(parseAmount(formatted, decimals)).toBe(0n + parsed);
    }
  });

  it('round-trips arbitrary bigints', () => {
    for (let iter = 0; iter < 500; iter++) {
      const decimals = decimalSets[randomInt(decimalSets.length - 1)];
      const raw = BigInt(randomDigits(randomInt(20) + 1));
      const formatted = formatAmount(raw, decimals);
      expect(parseAmount(formatted, decimals)).toBe(0n + raw);
    }
  });

  it('rejects inputs with one extra fractional digit', () => {
    for (const decimals of decimalSets) {
      const input = `0.${randomDigits(decimals + 1)}`;
      expect(() => parseAmount(input, decimals)).toThrow(AmountError);
    }
  });
});

describe('getTokenInfo', () => {
  const makeSource = (
    info: TokenInfo,
    onCall?: () => void,
  ): TokenInfoSource & { calls: number } => {
    const state = {
      calls: 0,
      async getTokenInfo() {
        state.calls += 1;
        onCall?.();
        return { decimals: info.decimals, symbol: info.symbol, name: info.name };
      },
    };
    return state;
  };

  beforeEach(() => {
    clearTokenInfoCache();
  });

  it('reads decimals, symbol and name from the token contract', async () => {
    const source = makeSource({ decimals: 7, symbol: 'XLM', name: 'Lumen' });
    const info = await getTokenInfo(TOKEN_A, source);
    expect(info).toEqual({ decimals: 7, symbol: 'XLM', name: 'Lumen' });
    expect(source.calls).toBe(1);
  });

  it('caches results per token address', async () => {
    const source = makeSource({ decimals: 6, symbol: 'USDC', name: 'USD Coin' });
    const a = await getTokenInfo(TOKEN_A, source);
    const b = await getTokenInfo(TOKEN_A, source);
    expect(a).toEqual(b);
    expect(source.calls).toBe(1);
  });

  it('caches independently for different tokens', async () => {
    const source = makeSource({ decimals: 7, symbol: 'XLM', name: 'Lumen' });
    await getTokenInfo(TOKEN_A, source);
    await getTokenInfo(TOKEN_B, source);
    expect(source.calls).toBe(2);
  });

  it('rejects invalid decimals returned by the contract', async () => {
    const source: TokenInfoSource = {
      async getTokenInfo() {
        return { decimals: -1, symbol: 'BAD', name: 'Bad' };
      },
    };
    await expect(getTokenInfo(TOKEN_A, source)).rejects.toThrow(AmountError);
  });

  it('rejects invalid token addresses', async () => {
    const source = makeSource({ decimals: 7, symbol: 'XLM', name: 'Lumen' });
    await expect(getTokenInfo('not-an-address', source)).rejects.toThrow(AmountError);
  });
});
