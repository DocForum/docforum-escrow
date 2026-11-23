---
file: ARCHITECTURE_ESSENTIALS.md
after: "get_escrow(escrow_id) -> EscrowData"
---
The `docforum-escrow-interface` crate provides the Soroban-compatible
`EscrowClient`, `EscrowData`, `EscrowStatus` and `Error` types for Rust
contracts that call this surface. A calling contract must arrange auth for
the payer and releaser used by its nested invocation; the escrow contract
still enforces those roles on-chain.
