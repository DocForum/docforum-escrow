bump: patch
---
Issue #286: `transfer_payee` resets `notify_payee = false` so that reassigning payout rights to a new payee (account or contract) cannot render the escrow permanently unreleasable with `CallbackFailed`.
