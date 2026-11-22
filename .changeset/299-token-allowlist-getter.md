---
"@docforum/escrow-sdk": minor
---

Add `getAllowedTokens()` (issue #299), returning the immutable deploy-time token allowlist as `string[]`; an empty array means any token is accepted. Additive only; the generated bindings were regenerated from the contract WASM.
