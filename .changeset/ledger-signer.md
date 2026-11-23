---
"@docforum/escrow-sdk": minor
---

Add `LedgerSigner` on the `@docforum/escrow-sdk/signers/ledger` subpath.
It wraps an injected Ledger Stellar app instance for transaction-envelope and
Soroban authorization signing, detects disabled hash signing, and never falls
back to software signing. The Ledger app package and its WebHID/Node HID
transport remain optional peer dependencies.
