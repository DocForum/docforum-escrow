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

## Multisig releaser account

The cheapest mitigation for trust assumption T1 (a leaked releaser key) needs
no contract change: make the releaser a Stellar account controlled by an M-of-N
signer set. `buildMultisigSetup` builds the classic `setOptions` transaction for
that account and refuses any configuration that would lock it out.

```ts
import { buildMultisigSetup } from "@docforum/escrow-sdk";
import { Account } from "@stellar/stellar-sdk";

const { transactions, dryRun } = buildMultisigSetup({
  account: releaserAccount,
  signers: [
    { key: signerA, weight: 1 },
    { key: signerB, weight: 1 },
    { key: signerC, weight: 1 },
  ],
  // Applied to the low, medium and high thresholds unless overridden.
  threshold: 2,
  // Pass the account as loaded from Horizon when you intend to submit;
  // the default has sequence number 0 and is only good for inspection.
  sourceAccount: new Account(releaserAccount, currentSequence),
});

console.log(dryRun.summary);
// Sign and submit the single transaction; it is atomic, so the account is
// never left with signers but not thresholds (or vice versa).
```

Every `setOptions` operation carries the new thresholds, one operation installs
each additional signer, and the master key weight is zeroed **last** — all in a
single transaction. The helper throws:

- `MultisigLockOutError` when the signer weight left after the setup is below
  the high threshold, when the thresholds are not `low <= medium <= high`, or
  when the account's own key is listed as a signer while `removeMasterKey` is
  `true`;
- `MultisigValidationError` for an empty signer list, duplicate signer keys, a
  weight outside `1..255`, or a threshold outside `1..255`.

Pass `removeMasterKey: false` to keep the master key (for example while
migrating); the account's own key is then listed in `signers` and its weight is
applied as the master key weight.

## Dry run

`dryRunMultisigSetup` validates a policy and returns the resulting thresholds,
signer weights and operation count without building a transaction.
`printMultisigDryRun` prints that summary.

```ts
import { dryRunMultisigSetup, printMultisigDryRun } from "@docforum/escrow-sdk";

printMultisigDryRun(
  dryRunMultisigSetup({
    account: releaserAccount,
    signers: [
      { key: signerA, weight: 1 },
      { key: signerB, weight: 1 },
      { key: signerC, weight: 1 },
    ],
    threshold: 2,
  }),
);
```

## Verifying on-chain state

`verifyMultisig(policy, { server })` reads the account's on-chain thresholds and
signer weights from Horizon and reports whether they match the intended policy.
It does not throw on a mismatch — inspect `matches` and `differences`.

```ts
import { verifyMultisig } from "@docforum/escrow-sdk";
import { Horizon } from "@stellar/stellar-sdk";

const result = await verifyMultisig(
  {
    account: releaserAccount,
    signers: [
      { key: signerA, weight: 1 },
      { key: signerB, weight: 1 },
      { key: signerC, weight: 1 },
    ],
    threshold: 2,
  },
  { server: new Horizon.Server("https://horizon-testnet.stellar.org") },
);

if (!result.matches) {
  console.error(result.differences);
}
```

The helpers are client-side only, target testnet, and do not change the escrow
contract surface: the contract still sees one account address.

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
