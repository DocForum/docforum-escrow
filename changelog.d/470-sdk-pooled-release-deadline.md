Issue #470 (Phase E6): the TypeScript SDK can create a pooled escrow with a
`releaseDeadline` (`create_pooled_release_deadline`, contract #288), and
otherwise calls `create_pooled_escrow` exactly as before. `getPooled` decodes
`releaseDeadline`, and the new `closeFailedRound(escrowId, { source })` wraps
the permissionless `close_failed_round` (#289). The Go SDK's `PooledData` gains
`ReleaseDeadline *uint64`, and decoding a deployment without the field still
works. No contract change.
