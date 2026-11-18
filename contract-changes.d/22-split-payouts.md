bump: minor
---
Issue #22: split payouts (ADR 0014). New `create_split_escrow` releases one escrow to up to `MAX_PAYEES` (8) payees by basis points (unique recipients, shares totalling 10 000 bps, rounding dust to the last payee; fees come off first). `EscrowData` gains a `payees` list (a single entry for ordinary escrows). New errors `InvalidPayeeList`, `TooManyPayees`, `DuplicatePayee`, `InvalidBasisPoints`, `SplitAmountOverflow` (provisional 2200-2204). Each share is sent with the same checked transfer as ordinary releases (`Undeliverable` on failure).
