---
file: ROADMAP.md
section: Phase E5 — Releaser custom account
---
- [x] Custom releaser account rotation (issue #302): the account may authorize
  `rotate_releaser` for its configured escrow when the payer also authorizes;
  rotation consumes one per-window operation slot and is covered by unit and
  end-to-end tests. See ADR 0005.
