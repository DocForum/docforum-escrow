Issue #289 (Phase E5): failed pooled rounds now become `Refunded` when the
final contribution is claimed. Zero-contribution failed rounds can be closed
permissionlessly after their deadline, and both paths emit the terminal
`ESCROW` snapshot without changing liabilities.
