---
"@docforum/escrow-sdk": minor
---

Widen `MilestoneStatus` to include `"cancelled"` and map `Cancelled` tranche escrows to `"cancelled"` in `getMilestones` (issue #329). Minor bump because `MilestoneStatus` is a widened union; consumers switching on `MilestoneStatus` may need a new `"cancelled"` branch.
