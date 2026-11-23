Issue #336: `Cancelled` (payer withdrawal before payee acceptance, ADR 0010)
is now terminal in `@docforum/escrow-react`. `isTerminalStatus` is an
exhaustive switch over every `EscrowStatus`, so a future status fails the
build until it is classified. `useEscrow` stops polling a cancelled escrow and
`useEscrowTimeline` stops its countdown for one. React Testing Library tests
cover the polling and countdown paths.
