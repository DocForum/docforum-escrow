---
"@docforum/escrow-sdk": minor
---

Support running the integration suite against a local Stellar network, and
complete the relayed-settlement API the README and integration suite already
documented.

- `EscrowClient` accepts `allowHttp: true` for a plain-HTTP RPC endpoint such as
  `stellar/quickstart` on `http://localhost:8000`. It defaults to `false`, so a
  public RPC can never be reached over an unencrypted connection by accident.
- `authorizeRelease` / `authorizeRefund` simulate a settlement with a relayer as
  the source account and have the releaser sign only its short-lived contract
  authorization entry (ten ledgers), returning `{ transaction,
  expiresAtLedger }`. Nothing is submitted.
- `submitRelayed("release" | "refund", authorization, relayer)` signs the
  envelope as the relayer, pays the fee, submits it, and refuses an expired
  authorization instead of retrying it.

Additive surface: existing calls are unchanged.
