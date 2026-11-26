---
"@docforum/escrow-sdk": minor
---

Add token-aware amount parsing and formatting (Phase E6, issue #81).

- `getTokenInfo(token)` (and `client.getTokenInfo(token)`) reads and caches
  `decimals`, `symbol` and `name` from a SEP-41 token contract.
- `parseAmount(value, decimals)` and `formatAmount(amount, decimals)` convert
  between decimal strings and raw `bigint` with strict, locale-independent
  validation: floats, exponents, thousands separators, signs and excess
  fractional precision are rejected with `AmountError`, never rounded.
- Property tests assert `format(parse(x)) == normalise(x)`.

Additive surface; existing callers passing raw `bigint` amounts are unchanged.
