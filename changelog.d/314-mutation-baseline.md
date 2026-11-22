Issue #314 (Phase E7): the nightly mutation run now fails on survivors it was
not told to accept. `contracts/escrow/.cargo/mutants-baseline.txt` lists the
accepted survivors, one line and one reason each, and
`scripts/mutation-baseline.mjs` diffs `mutants.out/missed.txt` against it —
matching on the mutation description (function + mutation) rather than
`file:line:col`, so unrelated edits that shift line numbers do not churn the
baseline. The job summary lists every survivor, the exact baseline line that
would accept it, and any baseline entry that no longer survives. The baseline
starts empty, so every survivor fails until it is either killed by a test or
accepted with a reason. `mutants.toml`'s `examine_globs` now covers all of
`src/`: it still named only `src/lib.rs`, which stopped holding contract code
when the contract was split into one module per area, so the job was mutating
nothing. No contract or SDK change.
