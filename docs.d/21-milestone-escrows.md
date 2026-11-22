---
file: ARCHITECTURE_ESSENTIALS.md
section: Contract surface
---
Milestone escrows use a fixed positive tranche schedule whose amounts sum to
the funded amount. `create_escrow_with_milestones` stores the schedule,
`get_milestones` exposes release state, and `release_milestone` pays one
unreleased tranche in any order. Standard full release, top-up, and split
settlement cannot bypass the schedule. Refunds return only the unpaid
remainder. This contract feature is not deployed to testnet.
