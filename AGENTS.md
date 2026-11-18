# AGENTS.md — docforum-escrow

Instructions for coding agents working in this repo.

Read `README.md` and `ARCHITECTURE_ESSENTIALS.md` in this repo first — this
repo is intentionally scoped narrowly and self-contained. You should not
need `docforum-core`'s docs to work here; if you find yourself needing
healthcare/PRD context to make a decision in this repo, that's a signal
the change belongs in `docforum-core` instead, not here.

## Non-negotiable rules
- No PHI. No healthcare domain concepts (patient, doctor, referral, etc.)
  anywhere in this repo — see `ARCHITECTURE_ESSENTIALS.md` hard rule 1.
- Contract changes need contract tests in the same PR, always.
- Never edit `CONTRACT_VERSION` or renumber an `Error` code. A PR that
  changes `contracts/escrow/src/lib.rs` adds a fragment under
  `contract-changes.d/`, and new `Error` variants use a provisional code
  (issue number × 100 + n). A maintainer bumps the version and assigns final
  codes. See `contract-changes.d/README.md`; CI enforces it.
- Testnet only, per `ARCHITECTURE_ESSENTIALS.md` hard rule 4, until an
  explicit security-review milestone (ROADMAP.md Phase E4) is marked done.
- Update `ROADMAP.md` on every contribution — org-wide rule, applies here
  too. Tick or update your own item's line, and put the changelog entry in
  a new file under `changelog.d/` (see below).

## Shared docs: keep your diff to your own lines

Many PRs are open at the same time and most of them touch the same docs.
Edits to shared lines are what put PRs into merge conflict with each other.

- Add your own line or table row. Don't rewrite, reorder or re-wrap
  paragraphs you don't need to change.
- Changelog entries go in a new file under `changelog.d/`, never at the end
  of `ROADMAP.md` (see `changelog.d/README.md`). Leave the status summary at
  the top of `ROADMAP.md` and each phase's `**Status:**` line to maintainers.
- Don't put running totals in docs ("57 tests", "Last updated: …"). CI and
  git history already record them, and every PR would have to change them.
- Commit docs as plain text and change only the lines you mean to. Never
  commit a file as base64, or regenerate a whole doc to make a small change.
- The contract surface is listed in one place: `ARCHITECTURE_ESSENTIALS.md`
  → "Contract surface". `README.md` only summarizes it and links there, so
  a new or changed contract function is one edit, not two.
- `sdk/src/generated/contract-client.ts` is generated. If it conflicts after
  a rebase, don't hand-merge it: take `main`'s version, then regenerate it
  from your contract (`CONTRIBUTING.md` → Generated SDK bindings).
