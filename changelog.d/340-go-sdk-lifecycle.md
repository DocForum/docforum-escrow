Issue #340 (Phase E6): the Go client now covers the payee-acceptance lifecycle.
`CreateEscrowWithAcceptance` wraps `create_escrow_with_acceptance`, and
`Accept`, `Cancel` and `TransferPayee` wrap `accept`, `cancel` and
`transfer_payee`. Each takes the acting party's `Signer` per call — the payee
for accept and transfer, the payer for cancel — because those parties differ
from the client's default signer; `nil` falls back to `Config.Signer`, and when
the party differs from it the configured account stays the transaction source
(it pays the fee) while the party signs its own Soroban auth entry. Contract
codes 18 `AcceptanceRequired`, 19 `AcceptanceNotConfigured`, 20
`AlreadyAccepted` and 37 `InvalidNewPayee` now have named sentinels, the full
contract error table is mapped, and the contract's `Cancelled` escrow status
decodes (`EscrowStatusCancelled`). Argument XDR is pinned by offline tests;
the opt-in
accept → release and cancel flows run against a real deployment. No contract
change.
