Issue #469 (Phase E6): `createEscrow({ unique: true })` makes creation
idempotent per `(payer, conditionRef)` through `create_escrow_with_uniqueness`
(contract #47). A duplicate at simulation or submission resolves to the
existing escrow (`existing: true`, no transaction) after its payee, token and
amount are checked against the request, and a mismatch throws
`UniqueEscrowMismatchError`. A settled duplicate returns its id and terminal
status. New `getUniqueEscrow(payer, conditionRef)`. `unique: false` or an
omitted flag sends exactly the same `create_escrow` call as before (the tests
compare the encoded arguments). No contract change. The opt-in testnet case is
skipped by default because the recorded testnet deployment predates #47.
