---
file: ROADMAP.md
section: Phase E6 — SDK & integrator tooling
---
- [x] Go SDK lifecycle entry points (issue #340): `CreateEscrowWithAcceptance`,
  `Accept`, `Cancel` and `TransferPayee` wrap `create_escrow_with_acceptance`,
  `accept`, `cancel` and `transfer_payee`. The acting party's `Signer` is
  passed per call (the payee for accept/transfer, the payer for cancel); when
  it differs from `Config.Signer` the configured account stays the transaction
  source and pays the fee while the actor signs its own auth entry. Contract
  codes 18–20 and 37 have named sentinels and the `Cancelled` status decodes;
  offline argument-XDR tests plus opt-in accept → release and cancel flows.
