# contract-changes.d

One new file per PR that changes the escrow contract
(`contracts/escrow/src/lib.rs`).

When every contract PR bumped `CONTRACT_VERSION` itself, all of them edited
the same line and picked the same "next" version, so each contract merge put
every other contract PR into conflict. Now you describe the change in a
fragment, and a maintainer bumps the version once for a whole batch.

CI (`scripts/check-contract-change.mjs`) enforces this on every PR that
touches `lib.rs`.

## Adding your fragment

1. Create `contract-changes.d/<issue-number>-<short-slug>.md`, for example
   `contract-changes.d/35-emergency-pause.md`.
2. The first line is the bump level, then a `---` line, then a one-paragraph
   summary of the contract change:

   ```markdown
   bump: minor
   ---
   Issue #35: emergency pause (ADR 0011). New `pause`/`unpause` entry points
   and `Paused`, `AlreadyPaused`, `NotPaused` errors; outbound paths are
   never blocked.
   ```

   - `patch`: behaviour fix, no interface change.
   - `minor`: new entry points, arguments, events or errors (backwards
     compatible for existing callers).
   - `major`: a breaking change to existing entry points or storage.
3. Commit it in the same PR as your contract change.

## Don't edit `CONTRACT_VERSION`

Leave `pub const CONTRACT_VERSION` in `lib.rs` exactly as it is on `main`.
CI fails a PR that changes it. The maintainer fold
(`node scripts/fold-contract-changes.mjs`) sets it.

## New `Error` codes

`Error` codes are append-only: never renumber or remove an existing variant.
For a new variant, use a **provisional** code of your issue number × 100 + n,
for example issue #35 adds `Paused = 3500`, `AlreadyPaused = 3501`,
`NotPaused = 3502`. Provisional codes can't collide with another open PR, so
two PRs adding errors can both merge without a duplicate code. The fold
renumbers provisional codes to the next free final codes; the changelog entry
it writes records the mapping. Refer to errors by name (`Error::Paused`) in
tests and the SDK, never by number.

If two PRs append to the end of the enum, git may still show a conflict
there. Keep both sides: their codes don't clash.

## What the maintainer fold does

`node scripts/fold-contract-changes.mjs` bumps `CONTRACT_VERSION` by the
largest level among the fragments, renumbers provisional error codes, writes
`changelog.d/contract-<version>.md`, and deletes the fragments. The maintainer
then refreshes test snapshots (`cargo test`) and the generated SDK bindings
(`scripts/check-generated-bindings.sh`), and commits everything in one PR.
