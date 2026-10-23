# Archived contract entries

Soroban can archive persistent contract entries after their storage TTL expires. The SDK exposes two behaviors through `EscrowClientConfig.archivalBehavior`:

- `"error"` (default) leaves restoration to the caller and throws `ArchivedEntryError` when an invocation requires archived state.
- `"auto"` enables the Stellar SDK's restore preamble handling. The SDK restores the required footprint and retries the original invocation once.

```ts
const client = new EscrowClient({
  contractId,
  archivalBehavior: "auto",
  // Needed when a read-only call encounters archived state.
  restoreSigner: restoreAccount,
});

const escrow = await client.getEscrow(escrowId);
```

For state-changing methods, the method's signer (`payer` or `caller`) signs and pays the restore transaction. Read-only methods need no signer for ordinary simulation; in automatic mode, provide `restoreSigner` to authorize and pay for a required restore. If that signer is missing or restoration fails, the SDK throws `ArchivedEntryError` with the method name and original cause. Keep enough XLM available for Soroban resource fees and the storage reserve required by the restore transaction.

Automatic restoration is limited to the SDK's one restore attempt and one retry of the original call. If the retry still reports archived state, the error is returned to the caller; the client does not loop.

# Token-aware amounts

Amounts are raw `bigint` values in the token's smallest unit. The decimals of a SEP-41 token are not guaranteed to be 7 (XLM and most Stellar assets are 7, but arbitrary tokens may differ). Converting by hand is error-prone, and a wrong decimal count means paying 10× or 0.1× the intended amount. Use the amount helpers instead.

## `getTokenInfo(token)`

Reads `decimals`, `symbol` and `name` from the token contract and caches the result per contract address. `client.getTokenInfo(token)` reads over the client's own RPC; the standalone `getTokenInfo(token, source?)` takes an optional `TokenInfoSource` so callers (and tests) can supply their own. Invalid contract addresses, and decimal counts outside `0..38` reported by a contract, throw `AmountError`.

```ts
import { EscrowClient, parseAmount, formatAmount } from "@docforum/escrow-sdk";

const client = new EscrowClient({ contractId });

const info = await client.getTokenInfo(tokenAddress);
// { decimals: 7, symbol: "native", name: "native" } for the XLM SAC

const raw = parseAmount("12.5", info.decimals); // 125000000n
const human = formatAmount(raw, info.decimals); // "12.5"
```

## `parseAmount(value, decimals)`

Converts a decimal string into a `bigint` in the token's smallest unit. Validation is strict:

- Only decimal digits and at most one `.` are accepted. No floats, exponent notation (`1e3`), hex, underscores, signs or whitespace.
- No thousands separators or locale-specific formatting.
- No negative values, including `-0`.
- No excess precision: inputs with more fractional digits than `decimals` are rejected, never silently rounded.
- `decimals` must be an integer between 0 and 38.

Throws `AmountError` (also exported as `InvalidAmountError`) with a descriptive message on any violation.

```ts
parseAmount("12.5", 7);        // 125000000n
parseAmount("0.0000001", 7);   // 1n
parseAmount("12.5", 2);        // 1250n
parseAmount("12.5", 0);        // throws AmountError
parseAmount("0.00000001", 7);  // throws AmountError (8 fractional digits)
parseAmount("1e3", 7);         // throws AmountError
parseAmount("1,000", 7);       // throws AmountError
parseAmount("-0", 7);          // throws AmountError
```

## `formatAmount(amount, decimals)`

Converts a `bigint` in the token's smallest unit into a normalised decimal string. Trailing fractional zeros are trimmed, and the fractional part is omitted when zero. Negative values are rejected.

```ts
formatAmount(125000000n, 7); // "12.5"
formatAmount(12500000n, 0);  // "12500000"
formatAmount(12500000n, 2);  // "125000"
formatAmount(1n, 7);         // "0.0000001"
```

## Property: `format(parse(x)) == normalise(x)`

`sdk/tests/amounts.test.ts` includes property tests asserting that for any valid input string `x` and decimals `d`, `formatAmount(parseAmount(x, d), d)` equals `normaliseAmount(x, d)` (leading and trailing zeros trimmed), and that any raw `bigint` round-trips through `formatAmount` and `parseAmount` unchanged.

## Example: creating an escrow with a token-aware amount

```ts
import { EscrowClient, parseAmount } from "@docforum/escrow-sdk";

const client = new EscrowClient({ contractId });
const info = await client.getTokenInfo(token);
const amount = parseAmount("12.5", info.decimals);
await client.createEscrow({ payer, payee, token, amount, conditionRef, releaser });
```

The amount helpers are additive and follow strict semver for the SDK. Existing callers that pass raw `bigint` amounts continue to work unchanged.
