---
file: docs/threat-model.md
section: T18 — Pooled funding-window manipulation · **Low–Medium (by design, documented)**
---
- **Release deadline recovery (issue #288 / ADR 0011):** pooled escrows may be
  created with an optional `release_deadline` (via `create_pooled_release_deadline`)
  strictly after `funding_deadline` (`InvalidReleaseDeadline`). When the release
  deadline passes on a fully funded pool without release, contributors can pull
  their contributions back with `claim_refund`, preventing a lost releaser key
  from locking pool funds forever. Release and claims at the boundary are mutually
  exclusive: once any claim has paid out, release is blocked (`FundingIncomplete`).
