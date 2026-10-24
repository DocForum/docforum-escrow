---
"@docforum/escrow-sdk": minor
---

Add lifecycle amendments (issue #84).

- `client.topUp({ escrowId, payer, amount })` and `client.accept({ escrowId, payee })`.
- `createEscrow` accepts `requiresAcceptance: true` (uses `create_escrow_with_acceptance`).
- `cancel` accepts any `EscrowSigner`, not just a `Keypair`.
- `topUp`, `accept` and `cancel` read the escrow first and throw
  `EscrowPreconditionError` with a `code` when the contract would reject the
  call. `checkPreconditions: false` skips the read.
- `prepareLifecycleCall` → `signLifecycleCall` → `submitLifecycleCall` for
  calls whose signers are on different machines. The prepared call is plain
  JSON.
- `getEscrow` returns `requiresAcceptance` and `acceptedAt`.

Additive surface; existing calls are unchanged.
