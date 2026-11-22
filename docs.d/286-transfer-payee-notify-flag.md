---
file: docs/threat-model.md
after: "consenting address without the method cannot complete release. See ADR 0005."
---
- When `transfer_payee` reassigns payout rights to a new payee, `notify_payee` is automatically reset to `false` (issue #286). This ensures that transferring an escrow to a plain account or a contract without the callback hook cannot leave the escrow permanently unreleasable with `CallbackFailed`.
