# contract-changes.d

One fragment per PR that touches `contracts/escrow/src/`, named
`<issue-number>-<short-slug>.md`. Describe the behaviour change, the new
tests that cover it, and whether the on-chain ABI or `CONTRACT_VERSION`
changed. Never edit `CONTRACT_VERSION` in a fragment; that is a separate,
explicit release step.
