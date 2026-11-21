# Contract change — 299: token allowlist getter

## Surface

```
__constructor(allowed_tokens: Vec<Address>)          // new, deploy-time
get_allowed_tokens() -> Vec<Address>                 // new, read-only
create_escrow(...) -> Result<u64, Error>             // same signature
Error::TokenNotAllowed = 29901                       // new, provisional
```

- The constructor writes `DataKey::AllowedTokens` once. There is no
  setter and no admin role, so the list is immutable for the instance's
  lifetime.
- `create_escrow` checks `token_allowed(token)` immediately after the
  positive-amount check and **before** `token.transfer`, so a rejected
  token costs the payer nothing. Empty list ⇒ allow any token.
- `get_allowed_tokens` reads the same storage key and is total: a missing
  key reads as an empty list. That state is unreachable through this
  WASM (the constructor always writes the key), but the fallback exists
  so a malformed instance cannot trap the getter.
- New error code `29901` is provisional per the repo convention
  (issue × 100 + 1). Append-only: existing codes 1–6 are unchanged, and
  `BalanceMismatch = 6` is now present in the regenerated bindings too.

## Why breaking for deployment, not for calls

`create_escrow`'s parameter list is unchanged, so existing SDK callers
compile and behave identically on an instance deployed with an empty
allowlist. Deployments must now supply constructor args; the contract has
not been redeployed to testnet in this change.

## Version

This repo does not define a `CONTRACT_VERSION` constant, so none was
edited. The SDK stays at `0.3.0` (additive surface only); the generated
bindings were regenerated from
`contracts/escrow/target/wasm32v1-none/release/docforum_escrow.wasm`.

## Tests

`contracts/escrow/tests/token_allowlist.rs`:

- `configured_allowlist_accepts_listed_token_and_rejects_unlisted_token`
- `empty_allowlist_preserves_open_token_behavior`
- `get_allowed_tokens_returns_every_configured_token_in_order`
- `allowlist_rejection_precedes_the_funding_transfer`

Every existing contract test now registers the contract with an explicit
empty allowlist (`Vec::<Address>::new(&env)`) and still passes.
