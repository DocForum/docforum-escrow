---
"@docforum/escrow-sdk": minor
---

Issue #35 (Phase E5): operator methods for the deposit-only emergency pause —
`pause`, `unpause`, `isPaused` and `getPauseAdmin`. The custodian is fixed at
deployment (`__constructor(allowed_tokens, pause_admin)`); while paused every
deposit path fails with `Paused`, and release/refund are never gated
(ADR 0011).
