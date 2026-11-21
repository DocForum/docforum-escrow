Issue #294 (Phase E5): added `rotate_releaser_with_approvals` so a quorum
escrow can replace one releaser with `threshold` member approvals plus the
payer's consent. The outgoing member's approval counts toward the
threshold. Tests in `contracts/escrow/tests/releaser_rotation.rs`. The
generated SDK bindings need regenerating from the new contract interface.
