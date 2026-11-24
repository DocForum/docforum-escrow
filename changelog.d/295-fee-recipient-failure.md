Issue #295 (Phase E4): documented and regression-tested the existing
fee-first release behavior when the fee recipient cannot receive. The release
fails atomically with `Undeliverable`, leaves the escrow funded, and can be
retried after the recipient is reachable; the payee is never partially paid.
