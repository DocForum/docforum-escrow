Issue #352 (Phase E7): added `.github/workflows/release-react.yml`, a
`react-v*`-tagged release workflow for `@docforum/escrow-react` that mirrors
the SDK's: it refuses to publish when the tag does not match
`packages/escrow-react/package.json`, typechecks, builds and tests the hooks,
packs and publishes with npm provenance through trusted publishing, and
attaches the tarball to the GitHub Release. Before publishing, a matrix job
typechecks and tests against the lowest and highest *published*
`@docforum/escrow-sdk` version matching the declared peer range; until the SDK
is on npm it falls back to the SDK in the checkout and warns. No contract or
SDK surface changed.
