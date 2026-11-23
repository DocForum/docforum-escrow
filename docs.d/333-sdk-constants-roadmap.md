---
file: ROADMAP.md
section: Phase E7 — Verification, testing & release engineering
---
- [x] SDK/contract constant check (issue #333):
  `scripts/check-sdk-constants.mjs` parses the contract's `pub const` limits and
  the SDK's exported mirrors (including `1_000`-style literals) and fails CI on
  a missing, unmapped or mismatched value; added the previously unmirrored
  `MAX_SETTLE_OPS` (12) to the SDK.
