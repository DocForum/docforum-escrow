---
file: ARCHITECTURE_ESSENTIALS.md
section: Contract surface
---
`__constructor(allowed_tokens, pause_admin, amount_caps)` fixes the immutable
per-token `(token, max_amount)` cap table used by all deposit paths; omitted
tokens are uncapped (issue #56, ADR 0016).
