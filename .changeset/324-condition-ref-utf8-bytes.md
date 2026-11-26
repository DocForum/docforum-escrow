---
"@docforum/escrow-sdk": patch
---

Count `conditionRef` length in UTF-8 bytes (matching the contract) in every create helper and in `milestoneConditionRef`, instead of UTF-16 code units (issue #324).
