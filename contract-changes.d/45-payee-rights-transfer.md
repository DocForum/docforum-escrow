bump: minor
---
Issue #45 (Phase E5): new `transfer_payee(escrow_id, current_payee, new_payee)`
entry point — only the current payee may authorize it, only while the escrow
is `Funded`, and `new_payee` may be neither the contract address nor the
payer. Emits a `pay_xfer` event and adds `Error::InvalidNewPayee` (provisional
code 4500, renumbered by the maintainer fold). Rotation tool, not key-loss
recovery; covered by `contracts/escrow/tests/transfer_payee.rs`.
