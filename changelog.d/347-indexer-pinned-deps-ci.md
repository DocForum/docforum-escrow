Issue #347 (Phase E7): the indexer's `@subql/*` packages and the runner versions
in `project.ts` are pinned to exact versions, `package-lock.json` is committed,
and `subql codegen` output (`src/types/`, `project.yaml`) is generated in CI
rather than committed. Added vitest mapping tests and an `indexer` CI job
(codegen + build + tests) that runs only when `indexer/**` changes.
