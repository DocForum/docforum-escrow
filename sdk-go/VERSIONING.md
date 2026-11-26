# Versioning — docforum-escrow Go SDK

## Module path

```
github.com/DocForum/docforum-escrow/sdk-go
```

The module lives in the `sdk-go/` subdirectory of this repository. Go module
versions for a module in a subdirectory must be tagged with that directory as a
prefix:

```
sdk-go/v0.1.0
```

Tags without the `sdk-go/` prefix belong to the repository root and are not
valid versions for this module.

## Semver plan

- **`v0.x` while the contract is testnet/local-only** (ARCHITECTURE_ESSENTIALS.md
  hard rule 4 / ROADMAP.md Phase E4). The API may still change.
- **Any public-surface change while major is 0** bumps the minor version
  (`v0.1.0` → `v0.2.0`), matching the TypeScript SDK's 0.x convention
  (`0.5.0` → `0.6.0` for an additive change).
- **Patch releases** are for fixes that do not change the public surface
  (`v0.2.0` → `v0.2.1`).
- **`v1.0.0`** is reserved for after the security review makes non-testnet use
  acceptable, at which point normal semver applies: breaking changes require a
  major bump.

A change to the contract's public signatures or `EscrowData` layout is a
breaking SDK change even if the Go method names stay the same, because callers
depend on field availability and semantics. Bump the minor version and update
`README.md` plus the contract tests in the same change.

## Release checklist

1. Update `sdk-go/README.md` if the public surface changed.
2. `cd sdk-go && gofmt -l . && go vet ./... && go test ./...`
3. Commit, then tag `sdk-go/vX.Y.Z`.
4. Push the tag: `git push origin sdk-go/vX.Y.Z`.
5. Consumers install with
   `go get github.com/DocForum/docforum-escrow/sdk-go@vX.Y.Z`.

The TypeScript SDK has its own independent version line (`sdk-v*` tags); the two
SDKs are versioned separately.
