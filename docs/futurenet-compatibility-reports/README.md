# Futurenet compatibility reports

Stellar ships protocol upgrades to futurenet before they reach testnet
and mainnet. Host behaviour, fees or test utilities can change. This
directory holds one short report per upcoming protocol version, written
after running the contract and SDK integration suite against futurenet.

The goal is to find breakage on futurenet before it reaches testnet,
rather than when the live deployment breaks.

## How to produce a report

1. Run the `Futurenet compatibility checks` workflow (`workflow_dispatch`
   or wait for the weekly schedule). It builds the current WASM,
   deploys it to futurenet, and runs `sdk/tests/futurenet-integration.test.ts`.
2. Copy the run summary and the contract ID into a new file named after the
   protocol version futurenet is running (e.g. `protocol-23.md`).
3. Record breaking changes found and the fixes needed, if any.
4. Add a `changelog.d/<issue>-<slug>.md` fragment describing the report
   (Phase E7) — `ROADMAP.md` is folded from those fragments, never edited
   directly.

## Notes

- Futurenet is reset often. A contract ID in a report is only valid
  for the run that produced it; treat a missing or unreachable contract
  as a network reset, not a failure of the contract.
- This workflow never blocks PRs. It is manual / scheduled only.
- Mainnet remains out of scope -- see [hard rule 4](../../ARCHITECTURE_ESSENTIALS.md#hard-rules).
