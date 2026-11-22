---
file: ROADMAP.md
section: Phase E5 — Contract features
---
- [x] Recurring escrows funded through token allowances (issue #115, ADR 0015): `create_schedule` records a payer/payee/token/amount/period/count schedule; any keeper may call `fund_next` when a period is due, pulling exactly one period's amount via `transfer_from` under the payer's SEP-41 allowance and creating a normal escrow for it; the payer may cancel at any time. Tests: `contracts/escrow/tests/recurring.rs`. **Not yet on testnet.**
