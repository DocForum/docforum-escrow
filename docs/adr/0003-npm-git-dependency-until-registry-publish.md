# ADR 0003: Consume `@docforum/escrow-sdk` via npm's git-subdirectory dependency, not GitHub Packages, until a real registry publish is possible

Status: Accepted (interim)

## Context

Issue #5 asks: npm or GitHub Packages for publishing `@docforum/escrow-sdk`?
The issue itself names the deciding constraint: *"needs to work for
`docforum-core` (a separate repo/org member) to actually install it —
don't pick something that silently requires auth `docforum-core`'s CI
won't have."*

That constraint rules out GitHub Packages outright: GitHub's npm registry
requires an authenticated `.npmrc` token to `npm install` a package **even
when the package and its repo are public**. Any external Wave contributor
forking `docforum-core` and running `npm ci` with no token configured
would get a hard failure — exactly the outcome the issue warns against.

The other option, the public npm registry, has no such problem —
anonymous `npm install` just works — but publishing there requires an
npmjs.com account and publish token, credentials this environment does
not have and cannot create (npm account creation is a human, out-of-band
step, same category as the Drips Wave application itself).

## Decision

**Interim:** `docforum-core` depends on the SDK via npm's native
git-subdirectory dependency support against this already-public GitHub
repo:

```json
"@docforum/escrow-sdk": "github:DocForum/docforum-escrow#path:sdk"
```

`npm install` clones the public repo (no auth needed — it's public),
resolves `sdk/` as the package root, runs its `prepare` script (added in
this same change: `npm run build`, i.e. `tsc`) to produce `dist/`, and
installs the result. This satisfies the issue's own constraint exactly:
zero auth required, works for any fork, works in CI with no secrets.

**Long-term (not yet actionable):** publish to the public npm registry
once real npmjs.com publishing credentials exist. When that happens,
`docforum-core` switches its dependency line to a normal semver range
(`"@docforum/escrow-sdk": "^0.1.0"`) and this ADR is superseded, not
edited — same convention as ADR 0002 in `docs/testnet-deployments.md`.

## Why not GitHub Packages, restated plainly

GitHub Packages' npm registry is genuinely the more "native" fit for a
GitHub-hosted org, but its auth-required-for-public-packages behavior is
a real, well-documented limitation, not an oversight — it would work fine
for the maintainer's own machine (already authenticated) while silently
breaking for exactly the audience issue #5 cares about protecting:
outside contributors.

## Consequences

- `docforum-core`'s `package-lock.json` will pin a git commit SHA for
  this dependency (npm's normal behavior for git dependencies), not a
  semver range — acceptable for an interim measure, revisited at the
  long-term publish.
- Anyone installing `docforum-core` needs network access to
  `github.com` at install time (already true for npm generally) and a
  Rust-free environment is fine — the git dependency only touches
  `sdk/`, never `contracts/escrow/`.
- `sdk/package.json`'s `"files": ["dist"]` doesn't govern what a git
  dependency installs (that's a registry-publish-time concept); the
  consumer effectively gets the whole `sdk/` subtree post-`prepare`.
  Harmless here (no secrets or generated cruft live there beyond
  `dist/`, itself gitignored and rebuilt fresh by `prepare` on install).
