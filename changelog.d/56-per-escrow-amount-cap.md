Issue #56 (Phase E5): added immutable per-token escrow amount caps for a
guarded staged mainnet-beta deployment. Capped tokens reject over-limit
creation, pooled funding, batch items, and aggregate top-ups; uncapped tokens
remain available when omitted from the constructor table.
