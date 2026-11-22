---
file: ARCHITECTURE_ESSENTIALS.md
after: "__constructor(allowed_tokens: Vec<Address>, pause_admin: Address)"
---
get_allowed_tokens() -> Vec<Address>   // IMPLEMENTED (issue #299) — read-only immutable deploy-time allowlist (empty = any token)
