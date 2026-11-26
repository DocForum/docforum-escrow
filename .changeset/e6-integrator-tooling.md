---
"@docforum/escrow-sdk": minor
---

Add integrator tooling (Phase E6, issues #127 and #129).

- `EscrowClient` accepts a SEP-43 `Signer` (or a local `Keypair`) for
  `payer`, `caller`, `approvers` and estimate `source`.
- New `@docforum/escrow-sdk/signers/wallets-kit` subpath exports
  `WalletsKitSigner`. Stellar Wallets Kit is an optional peer dependency and
  is injected at runtime, so importing the package root never pulls wallet
  code. Wrong-network signing throws `WalletNetworkMismatchError`; user
  rejection is returned as SEP-43 error code `-4`.
- Optional `instrumentation` / `onEvent` config adds spans (or timing events)
  for `simulate`, `sign`, `submit` and `confirm`, with `contract.id`,
  `contract.function`, `escrow.id`, `tx.hash` and `retry.count` attributes.
  `@opentelemetry/api` is an optional peer dependency and the disabled path
  does no timing work. Addresses are only included with
  `includeAddresses: true`.

Additive surface; existing `Keypair`-based calls are unchanged.
