Issue #71 (Phase E6): added a milestone (tranche) surface to the SDK —
`createMilestoneEscrow`, `releaseMilestone`, `refundMilestone`,
`getMilestones`, plus `validateMilestoneSchedule` / `MilestoneScheduleError`
and `MilestoneEscrowPartialError`.

The deployed contract is single-tranche and the native multi-tranche entry
point is still the Phase E5 contract work (issue #21), so a schedule is
modelled client-side as one ordinary escrow per tranche, tagged
`<conditionRef>#m<i+1>/<n>`. No contract change and no hand-edit of
`sdk/src/generated/contract-client.ts` — the generated bindings are
byte-identical to a fresh generation from the current WASM, which is what the
`SDK bindings match contract WASM` CI check verifies. `sdk/package.json`
gains `test:milestones`, run by CI; the schedule arithmetic, the ref tagging,
the per-tranche settlement calls and the partial-failure state are all
covered by offline tests.
