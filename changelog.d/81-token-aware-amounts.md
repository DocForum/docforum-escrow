Issue #81 (Phase E6): added token-aware amount helpers to the SDK
(`sdk/src/amounts.ts`). `getTokenInfo(token)` reads `decimals`, `symbol` and
`name` from the SEP-41 token contract and caches them per address;
`parseAmount('12.5', decimals)` and `formatAmount(bigint, decimals)` convert
with strict validation — floats/exponents (`1e3`), excess fractional
precision (`0.00000001` at 7 decimals), thousands separators and negatives
(including `-0`) are rejected rather than rounded. Property tests cover
`format(parse(x)) == normalise(x)` and run in CI via `npm run test:unit`.
Additive SDK surface, no contract change, so the generated bindings are
unchanged. The web demo now shows amounts via `formatAmount`.
