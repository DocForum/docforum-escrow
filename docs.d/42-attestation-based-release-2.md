---
file: ARCHITECTURE_ESSENTIALS.md
after: "create_escrow_with_releasers(payer, payee, token, amount, condition_ref, releasers, threshold, refund_after, notify_payee, refund_to) -> escrow_id"
---
create_escrow_with_attester(payer, payee, token, amount, condition_ref, releaser, refund_after, notify_payee, refund_to, attester) -> escrow_id // Phase E5, issue #42 — like create_escrow, plus an optional ed25519 attester key
release_with_attestation(escrow_id, signature) -> () // Phase E5, issue #42 — releases on a signed off-chain attestation; anyone may submit, the signature is the authority
