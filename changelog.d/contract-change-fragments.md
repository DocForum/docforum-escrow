Contract changes now use fragments in `contract-changes.d/` instead of each
PR bumping `CONTRACT_VERSION`, which put every open contract PR into conflict
on each contract merge. New `Error` variants use provisional codes
(issue number × 100 + n) until the maintainer fold
(`scripts/fold-contract-changes.mjs`) bumps the version once per batch and
assigns final codes. CI's "Contract changes use a fragment, not a version
bump" step (`scripts/check-contract-change.mjs`) replaces the old
"Require a contract version bump" step. The version test now compares with
`CONTRACT_VERSION` instead of a literal.
