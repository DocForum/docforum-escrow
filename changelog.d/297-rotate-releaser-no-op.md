Issue #297 (Phase E5): `rotate_releaser` now rejects a no-op rotation
(`new_releaser == current releaser`) with `InvalidReleaser` instead of
rewriting the same state and emitting a misleading `rotate` event. The
check runs after the caller check, so a wrong caller still gets
`Unauthorized`. Added rotation tests for pooled escrows (creator
co-signs), rotation after `refund_after`, the exact `rotate` event payload,
and `settle_many` from the rotated-out releaser.
