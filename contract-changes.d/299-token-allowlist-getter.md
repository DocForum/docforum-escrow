bump: minor
---
Issue #299: new read-only `get_allowed_tokens() -> Vec<Address>` returning the
immutable deploy-time token allowlist; an empty list still means any token is
accepted. No new storage key and no new error code — the constructor already
wrote `DataKey::AllowedTokens`, this only exposes it to integrators.
