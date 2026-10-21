Phase E6 integrator tooling (issues #126, #127, #128, #129).

#127: `EscrowClient` now accepts a SEP-43 `Signer` anywhere it accepted a `Keypair`; added `WalletsKitSigner` on the `@docforum/escrow-sdk/signers/wallets-kit` subpath with an injected, optional Wallets Kit peer and no runtime import of it. Wrong-network signing throws `WalletNetworkMismatchError`; user rejection is a normal SEP-43 `-4` outcome.

#129: optional `instrumentation`/`onEvent` with `simulate`/`sign`/`submit`/`confirm` spans and retry counts; addresses opt-in only; the disabled path does no timing work. SDK `0.5.0 → 0.6.0` (additive).

#126: new `@docforum/escrow-react` package with `useEscrow`, `useEscrowActions`, `useEscrowTimeline`, React Query caching and polling that stops at terminal statuses; 14 RTL tests and a CI job.

#128: new `sdk-go/` client with typed contract errors, `big.Int` i128 amounts, offline tests and an opt-in quickstart integration workflow.

Added `examples/web-demo/`, docs and roadmap entries. Closes #126, #127, #128, #129.

Go SDK: `GetEscrow` now decodes `refund_to` as the contract's `Address`
(`ScvAddress`) instead of a string, and the create helpers encode `RefundTo`
as an address-backed option. Fixes the quickstart integration job's
`expected string ScVal, got ScValTypeScvAddress` failure.