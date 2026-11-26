---
file: ARCHITECTURE_ESSENTIALS.md
after: "create_pooled_escrow(creator, payee, token, funding_target, condition_ref, releaser, funding_deadline) -> escrow_id"
---
create_pooled_quorum_escrow(creator, payee, token, funding_target, condition_ref, releasers, threshold, funding_deadline) -> escrow_id // IMPLEMENTED (issue #290) — pooled M-of-N settlement; same funding, allowlist and pause gates as create_pooled_escrow; release_with_approvals/settle_many only after full funding; not deployed on testnet yet
