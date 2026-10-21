Contributing: changelog entries now go in `changelog.d/` (one new file per
PR) instead of being appended to this section, which used to put most open
PRs into merge conflict on every merge. Maintainers fold them in with
`node scripts/fold-changelog.mjs`. The contract surface now lives only in
`ARCHITECTURE_ESSENTIALS.md` (the `README.md` section is a summary that
links there), with the few README-only details moved across, and its
`refund_to` ADR reference and timeout-refund destination corrected. Also
dropped the hard-coded test count from the README, and documented the
"edit only your own lines" and "regenerate, don't hand-merge,
`contract-client.ts`" rules in `AGENTS.md` and `CONTRIBUTING.md`. The
conflict notifier now points authors at `changelog.d/`.
