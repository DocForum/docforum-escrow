Issue #33 (Phase E5): decided how to list escrows by payer or payee (ADR 0015).
Chosen: off-chain. The contract is unchanged — the `ESCROW` event (issue #9)
already carries `payer`/`payee` and the issue #87 indexer already stores them, so
there is no `list_by_payer` / `list_by_payee` and no redeploy.
`EscrowIndexerClient.listEscrows` gained optional `payer`/`payee` filters that
pass through to the indexer's existing fields (SDK minor, additive); its test
now runs in the offline CI job.
