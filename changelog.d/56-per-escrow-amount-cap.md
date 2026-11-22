Issue #56 (Phase E5): added immutable per-token escrow amount caps for a
guarded staged mainnet-beta deployment. This adds a constructor argument and
is a breaking deploy-time interface change; existing instances must be
recreated or migrated. Empty caps preserve uncapped behavior. Capped tokens
reject over-limit creation, pooled funding, batch items, and aggregate top-ups.
