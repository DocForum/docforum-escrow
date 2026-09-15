# ADR 0003: Distribute `@docforum/escrow-sdk` as a GitHub Release tarball URL, not GitHub Packages, until a real registry publish is possible

Status: Accepted (interim) — **revised same day**: the git-subdirectory
dependency approach first written here (`github:owner/repo#path:sdk`) was
tested against `docforum-core` and failed — npm 10.8.2's git-dependency
resolver doesn't support a subdirectory selector the way this ADR
originally assumed (`npm warn npm-package-arg ignoring unknown key
"main"`, then `ENOENT` looking for `package.json` at the repo root
instead of `sdk/`). Replaced with the tarball-URL approach below, which
was actually verified working end-to-end.

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

The public npm registry has no such problem — anonymous `npm install`
just works — but publishing there requires an npmjs.com account and
publish token, credentials this environment does not have and cannot
create (npm account creation is a human, out-of-band step, same category
as the Drips Wave application itself).

A git-subdirectory dependency (`github:DocForum/docforum-escrow#path:sdk`)
was tried first as a zero-infrastructure middle ground, but doesn't
actually work — see the revision note above.

## Decision

**Interim:** `docforum-core` depends on a tarball attached to a real
GitHub Release on this repo:

```json
"@docforum/escrow-sdk": "https://github.com/DocForum/docforum-escrow/releases/download/sdk-v0.1.0/docforum-escrow-sdk-0.1.0.tgz"
```

The tarball is produced with plain `npm pack` in `sdk/` (respects
`"files": ["dist"]` — only `package.json` + `dist/` are included) and
attached to a tagged GitHub Release (`sdk-v0.1.0`) via `gh release
create`. Release assets on a public repo are downloadable over plain
HTTPS with **no authentication at all** — verified by actually running
`npm install` against that release URL from `docforum-core/backend` in a
clean environment: installed cleanly, and `import { EscrowClient,
Keypair } from "@docforum/escrow-sdk"` resolved correctly.

**Long-term (not yet actionable):** publish to the public npm registry
once real npmjs.com publishing credentials exist. When that happens,
`docforum-core` switches its dependency line to a normal semver range
(`"@docforum/escrow-sdk": "^0.1.0"`) and this ADR is superseded, not
edited — same convention as the superseded entry in
`docs/testnet-deployments.md`.

**Releasing a new SDK version:** bump `sdk/package.json`'s version,
`npm run build && npm pack` in `sdk/`, then `gh release create` on this
repo with a `sdk-v` + the new version as the tag and the packed tarball
as the asset, then update the tarball URL (including the new tag and
filename) in every consumer's `package.json`. Manual today; worth
scripting once there's a second consumer besides `docforum-core`.

## Why not GitHub Packages, restated plainly

GitHub Packages' npm registry is genuinely the more "native" fit for a
GitHub-hosted org, but its auth-required-for-public-packages behavior is
a real, well-documented limitation, not an oversight — it would work fine
for the maintainer's own machine (already authenticated) while silently
breaking for exactly the audience issue #5 cares about protecting:
outside contributors.

## Consequences

- No real semver range — the consumer's `package.json` pins an exact
  release tag + tarball filename. A version bump means both repos'
  `package.json`s change (source of truth here, dependency line in the
  consumer), not just one. This is more manual than a registry, and is
  explicitly the cost of the "interim" label.
- `sdk/package.json`'s `"prepare": "npm run build"` script (added
  alongside this decision) is unused by this specific approach (`npm
  pack` already builds and packs `dist/` before creating the release
  asset) but is harmless to keep — it's what would make a future git- or
  workspace-based dependency route build correctly, and costs nothing to
  leave in place.
