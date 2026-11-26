---
file: ROADMAP.md
section: Phase E4 — Security review (blocking for any mainnet use)
---
- [x] A hostile payee callback can block `settle_many` batches (issue #367).
  The whole-batch revert on a failing `notify_payee` callback is documented
  in ADR 0012 and threat model T11, pinned by
  `contracts/escrow/tests/settle_many.rs`; the mitigation — settle
  `notify_payee` releases one per transaction, refunds unaffected — is in
  the releaser-compromise runbook and the settlement tooling.
