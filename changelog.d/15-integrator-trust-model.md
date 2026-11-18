Issue #15 (Phase E4): added a "Trust model for integrators" section to
`README.md` covering the four properties integrators need before relying on a
`Funded` escrow: releaser control rather than payee commitment (T8), checking
the escrow's token rather than only its status (T5), the public and permanent
nature of `condition_ref`/`payer`/`payee`/`amount` (T9), and pinning the
caller-supplied `contractId` against the deployment record. Also documented the
same `condition_ref` privacy warning on `EscrowData`/`create_escrow` in
`contracts/escrow/src/lib.rs` and on `createEscrow` in `sdk/src/index.ts`.

Docs only — no contract or SDK behavior change. Because the contract's doc
comments are part of its on-chain spec, `sdk/src/generated/contract-client.ts`
was regenerated with the pinned Stellar CLI; review it as generated output, not
a hand edit.
