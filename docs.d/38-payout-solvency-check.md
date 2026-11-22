---
file: docs/threat-model.md
after: "shortfall; it does not prevent it. See *Solvency monitoring* below."
---
  - **Payout-time guard (issue #38):** every settlement path checks that the
    contract's current token balance covers the escrow amount before changing
    settlement state or calling the token. If a post-creation clawback leaves
    the pool short, the call returns `PoolInsufficient` and the escrow remains
    `Funded`. Operators should page on the shortfall, stop new escrows for the
    token, and restore the pool or use the token's recovery process before
    retrying the payout.
