bump: major
---
Issue #56: the constructor now accepts immutable per-token amount caps, a
breaking deploy-time interface change; existing deployments must be recreated
or handled by a migration. Empty caps preserve uncapped behavior. New
`AmountCapExceeded`/`InvalidAmountCap` errors protect creation, pooled funding,
batch creation, and `top_up` before token movement.
