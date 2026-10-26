# Protocol 23 -- futurenet compatibility report

Status: **first run pending** -- this report is created as the template
for the first futurenet protocol 23 run. The contract ID and results below
must be filled in from a real `Futurenet compatibility checks` workflow
run against futurenet while it is running protocol 23. Do not mark this as
verified until that run exists.

| |  |
|---|---|
| Network | Stellar Futurenet |
| Protocol version | 23 |
| Contract ID | (fill from workflow run summary) |
| WASM hash | (fill from workflow run summary) |
| Source commit | (fill from workflow run summary) |
| Workflow run | (link to the Actions run) |

## Summary

Pending the first run. This report exists so the report directory and
the changelog fragment have a real target before the first futurenet protocol 23
run completes.

## Breaking changes found

None recorded yet -- fill in after the first run. Categories to watch:

- Host behaviour changes (contract env, budget, event format).
- Fee changes affecting `testnet-integration.test.ts` transaction construction.
- Test utility changes (Stellar CLI, soroban-sdk prerelease).

## Fixes needed

None recorded yet.

## Notes

- Futurenet is reset often. If the contract ID is unreachable, re-run the
  workflow rather than treating it as a contract failure.
- This report is summarised in a `changelog.d/` fragment (Phase E7).
