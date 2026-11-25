Issue #368 (Phase E6): added `waitForStatus` to `EscrowClient`, which polls
`getStatus` until an escrow reaches one of the target statuses. It resolves
with `{ escrowId, status }` (a settled escrow's record is reclaimed, so
returning the full escrow would fail), rejects with a typed `WaitTimeoutError`
carrying the last status seen on timeout or when the escrow settles outside
the target set, and accepts an `AbortSignal`. Deadlines are enforced by their
own timer, so a large poll interval or a status read still in flight cannot
stall the wait, and no timer survives resolution, rejection or abort. New
public types `WaitForStatusOptions` and `WaitForStatusResult`, the constant
`TERMINAL_ESCROW_STATUSES`, and a README example. No contract change; SDK only.
