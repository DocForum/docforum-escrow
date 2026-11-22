Issue #21 adds first-class on-chain milestone escrows. A fixed positive
schedule must sum to the funded amount; tranches release once in any order,
partial escrows remain `Funded`, and refunds return only the unreleased
remainder. See [ADR 0012](../docs/adr/0012-milestone-escrows.md). This is
separate from the SDK's existing one-escrow-per-tranche grouping and is not
deployed to testnet.
