Issue #38 (Phase E5): settlement now checks the shared token pool before
transferring funds and returns `PoolInsufficient` clearly when a post-creation
clawback or other shortfall leaves an escrow underfunded.
