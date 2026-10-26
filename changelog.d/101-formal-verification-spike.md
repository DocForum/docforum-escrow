Issue #101 (Phase E4): added the formal-verification spike for invariants
I1–I3 and the timeout rule. `certora/escrow.spec` states each property against
the current settlement entry points and `Error` discriminants, and
`docs/formal-verification.md` records the scope, assumptions, out-of-scope
areas and current status (specified, not yet machine-checked — Certora Sunbeam
needs a licensed toolchain, so there is no CI job). The threat model links
I1–I3 to their properties. No contract behaviour or SDK surface changed.
