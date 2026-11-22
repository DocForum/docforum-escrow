Issue #299 (Phase E5): added read-only `get_allowed_tokens()` to the contract,
returning the immutable deploy-time token allowlist (`Vec<Address>`; empty
means any token). Integrators can now verify a deployment's accepted tokens
on-chain instead of trusting deployment notes. No new storage or error codes.
The SDK gains `getAllowedTokens()` and the generated bindings were
regenerated from the WASM.
