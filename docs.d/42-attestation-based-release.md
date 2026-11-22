---
file: ROADMAP.md
section: Phase E5 — Contract features
---
- [x] Attestation-based release (issue #42): optional `attester` (ed25519 public key) at creation and `release_with_attestation(escrow_id, signature)`, verified over a domain-separated message (contract id, network id, escrow id, action). Tests: `contracts/escrow/tests/attestation.rs`. **Not yet on testnet.**
