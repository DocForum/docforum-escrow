---
file: ROADMAP.md
section: Phase E7 — Verification, testing & release engineering
---
- [x] **Release workflow for `@docforum/escrow-react`** (issue #352) —
  `.github/workflows/release-react.yml` releases the hooks package from a
  `react-v*` tag: tag/version guard, typecheck, build, test,
  `npm publish --provenance` via trusted publishing, and the tarball attached
  to the GitHub Release. A peer matrix typechecks and tests against the lowest
  and highest published `@docforum/escrow-sdk` version matching the declared
  range before publishing, and falls back to the checkout's SDK with a warning
  until the SDK is on npm. Documentation in `CONTRIBUTING.md`.
