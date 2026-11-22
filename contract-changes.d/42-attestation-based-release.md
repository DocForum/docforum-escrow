bump: minor
---
Issue #42: attestation-based release. New `create_escrow_with_attester` and
`release_with_attestation` entry points, an optional `attester` field on
`EscrowData`, and a new `AttesterNotConfigured` error (provisional code
4200). No existing entry point or stored field changes shape.
