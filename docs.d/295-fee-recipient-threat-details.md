---
file: docs/threat-model.md
after: '*Key: "Covered" = at least one test explicitly exercises the threat and verifies the mitigation. "Residual risk: accepted" = the threat is understood and intentionally tolerated with a documented mitigation. "Uncovered" = no test or mitigation exists — should be evaluated for a future release.*'
---
### T295 — Fee recipient cannot receive at release · **Medium (liveness), document and retry**

- **What can go wrong:** the fixed fee destination can be deauthorized, lose
  its trustline, or otherwise reject the token transfer after the escrow was
  funded.
- **Effect:** release returns `Undeliverable` before the payee is paid. Soroban
  transaction atomicity restores the pre-call state: the escrow remains
  `Funded`, the full liability remains recorded, and no destination receives
  a partial payout.
- **Decision:** keep the release blocked until the fee recipient can receive.
  Paying the payee alone would leave the declared fee unpaid and violate I7's
  exact conservation rule. The releaser can retry once the recipient is
  reachable; a `fee_bps` of zero skips the fee transfer entirely.
- **Consumer mitigation:** validate the fee recipient's trustline and
  authorization before creating an escrow, monitor failed `Undeliverable`
  releases, and repair the destination before retrying. A payer who needs
  independent payee liveness should create a fee-free escrow.
