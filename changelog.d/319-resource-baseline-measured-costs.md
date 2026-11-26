Issue #319 (Phase E7): `scripts/check-resource-baseline.py` compares measured
Soroban costs instead of function source size, so a change that doubles a
function's CPU or memory cost fails even when its source shrinks.
`cargo bench --bench resource_profile` now emits a JSON snapshot (stdout, or
`--out <path>`), profiles every function in a fresh environment twice and fails
when the runs disagree; CI runs that bench before the check.
`benchmarks/baseline.json` is format 3, one `cpu_instructions` /
`memory_bytes` pair per function, and is raised only through
`scripts/update-resource-baseline.py --note "<why>"` with the reason in the PR.
The source-size heuristic is gone. No contract or SDK surface change, so
bindings and `contract-spec.json` are untouched.
