## What changed


## Which ROADMAP.md item does this close/progress?
(required — see AGENTS.md doc-update rules)

## Docs updated in this PR (check all that apply)
- [ ] ROADMAP.md
- [ ] ARCHITECTURE.md
- [ ] ARCHITECTURE_ESSENTIALS.md
- [ ] PRD.md
- [ ] New doc lines are in `docs.d/` fragments, not added to the docs directly (see `docs.d/README.md`)
- [ ] N/A for this change

## Contract changes (if applicable)
<!-- If this PR adds or changes a contract entry point under contracts/escrow/src/, tick through: -->
- [ ] Added to area module under `contracts/escrow/src/` (not `lib.rs`)
- [ ] Gated by `is_paused` if deposit path (`docs/adr/0011`) and listed in `DEPOSIT_ENTRYPOINTS` (`tests/pause.rs`)
- [ ] Contract liability tracking updated & covered by `solvency()` tests
- [ ] Events emitted & test snapshots committed (`contracts/escrow/test_snapshots/`)
- [ ] `contract-changes.d/` fragment added with provisional error code (`issue * 100 + n`)
- [ ] Generated SDK bindings checked/regenerated (`./scripts/check-generated-bindings.sh`)
- [ ] TypeScript SDK method & types added in `sdk/src/`
- [ ] Contract surface documented via `docs.d/` fragment for `ARCHITECTURE_ESSENTIALS.md`
