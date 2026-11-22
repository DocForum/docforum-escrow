Issue #125 (Phase E6): added the `LedgerSigner` SDK adapter for the Ledger
Stellar app. It supports transaction-envelope and Soroban authorization
signing through an injected WebHID/Node HID-backed app, reports disabled hash
signing explicitly, and has no software-signing fallback.
