Issue #339: added `useEscrowEvents({ escrowId?, types?, cursor? })` to
`@docforum/escrow-react`. The hook wraps `client.subscribe` in an effect with
cleanup on unmount and on parameter change (StrictMode leaves exactly one live
subscription), keeps a bounded oldest-first event list (`maxEvents`, default
100), exposes the latest cursor for persistence, invalidates the matching
escrow queries for escrows named in events, and surfaces
`EventCursorExpiredError` as `error` / `cursorExpired` state rather than
throwing. `EscrowClientLike.subscribe` is optional, so existing partial
clients keep working.
