# `sdk/src/generated/` — machine-generated, do not hand-edit

`contract-client.ts` is exactly what the pinned Stellar CLI emits from the
contract's compiled WASM. It is **not** edited by hand: every change to
`contracts/escrow/src/lib.rs`'s public functions, parameter types or doc
comments changes the contract spec baked into this file, so a hand edit would
silently drift from the contract the SDK claims to support (issue #121).

CI enforces this: `.github/workflows/ci.yml`'s `sdk-bindings` job rebuilds the
WASM, regenerates the bindings into a temp directory and diffs the generated
`src/index.ts` against the committed file. A hand edit — or a contract change
without regeneration — fails that job.

## Regenerating

The generator version is pinned in [`scripts/stellar-cli-version`](../../../scripts/stellar-cli-version);
install that exact version (the CI workflow downloads the release binary of the
same version, and `scripts/check-generated-bindings.sh` reads the same file).

```bash
cd contracts/escrow
cargo build --target wasm32v1-none --release

# Use the version from scripts/stellar-cli-version.
stellar contract bindings typescript \
  --wasm target/wasm32v1-none/release/docforum_escrow.wasm \
  --output-dir /tmp/escrow-bindings --overwrite

cp /tmp/escrow-bindings/src/index.ts ../../sdk/src/generated/contract-client.ts
```

Or run the whole check locally, which does the build, generation and diff for
you and prints the command above when the file is stale:

```bash
./scripts/check-generated-bindings.sh
```

Commit the regenerated file together with the contract change (hard rule 2 applies
to the contract tests; the bindings are part of the same change). A change in the
SDK's public surface also needs a semver bump for `@docforum/escrow-sdk` (hard
rule 3).

Notes:

- The generator's output is deterministic for a given WASM + CLI version, which
  is what makes the diff meaningful. The generated `README.md`/`package.json` in
  the output directory embed the output directory's name, so only
  `src/index.ts` is compared and committed.
- `stellar contract bindings typescript` is deprecated upstream in favour of the
  JavaScript Stellar SDK's own client generation. The pin keeps this
  reproducible for now; migrating is tracked by the ADR noted in
  `docs/adr/0007` and would be its own change (and its own PR).
