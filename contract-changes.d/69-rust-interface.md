bump: patch
---
Issue #69: the escrow contract now reuses the interface crate's shared
`EscrowData`, `EscrowStatus` and `Error` definitions. The exported contract
surface and behavior are unchanged.
