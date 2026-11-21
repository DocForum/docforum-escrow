# Docs — 299: token allowlist getter

## README.md

New contract-surface row:

> `get_allowed_tokens() -> Vec<Address>` — ✅ Implemented — Read-only: the
> immutable token allowlist this instance was deployed with. An empty list
> means any token is accepted. Takes no caller — anyone can verify it
> on-chain.

New section **“Token allowlist (deploy-time, immutable)”** explaining
that the constructor fixes the list, an empty list preserves the legacy
allow-any-token behaviour, unlisted tokens fail with
`Error::TokenNotAllowed` before funds move, and — explicitly — that
integrators must verify the allowlist on-chain with
`getAllowedTokens()` / `get_allowed_tokens()` rather than trusting a
deployment note or the README:

```ts
const allowed = await client.getAllowedTokens(); // string[]
if (allowed.length > 0 && !allowed.includes(token)) throw new Error("...");
```

The “Getting started” test count was corrected from 28 to 35.

## ARCHITECTURE_ESSENTIALS.md

- Contract-surface block gains
  `get_allowed_tokens() -> Vec<Address>` (read-only, empty = any token,
  implemented in Phase E5 / issue #299, not yet redeployed).
- New paragraph documenting `__constructor(allowed_tokens)`, the
  immutability, the `TokenNotAllowed` code, and the missing-key
  empty-list fallback.
- SDK-surface block gains
  `await client.getAllowedTokens(); // string[] — deploy-time token allowlist; [] = any token`.
