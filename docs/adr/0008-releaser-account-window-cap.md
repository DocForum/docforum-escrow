# ADR 0008: Per-window settlement cap for the releaser account

**Status:** Accepted

## Context

M-of-N signatures reduce the risk of a single compromised key, but a
compromised quorum could settle many open escrows quickly. A count cap limits
the number of release and refund operations accepted by one custom releaser
account during a ledger window.

## Decision

The custom account is initialized with a maximum operation count and a window
length in ledgers. Each successful custom-account authorization for one
`release` or `refund` consumes one slot. The invocation policy continues to
reject multiple or unrelated contexts, so callers cannot cover a batch with
one authorization. Separate settlement authorizations each consume a slot.

Usage is stored under a key containing the window index, in **temporary**
storage (issue #303): a counter only matters for the duration of its own
window, so it no longer pays persistent rent forever and past windows are
not retained. Each successful use sets the entry's TTL to the window length
plus a small margin, so a counter can never expire before its window ends
(which would let the cap be bypassed); older window keys expire on their
own without affecting the current counter. `window_usage(window)` returns 0
for an expired or missing counter instead of trapping.

Because this changes the storage layout, contracts deployed before the change
keep reading/writing the old persistent counters: their behaviour is unchanged
and the new temporary counters start fresh on the new deployment.

Changes to the cap or window length are signed over the account address and
management nonce, like other management operations, but require signatures
from every registered signer rather than only the normal M-of-N threshold.
The counter measures operation count, not value per token.

## Consequences

- A compromised quorum can still choose an outcome but can settle at most the
  configured number of operations per window.
- The count cap treats all token amounts equally; integrators needing value
  limits must use a separate policy.
- Short windows and low caps can delay legitimate settlements. Operators must
  choose settings that leave time for the T1 response without blocking normal
  activity.
- The releaser-account constructor changes and requires a new deployment.
  Testnet verification and independent review remain required before use with
  real value.

## Reference

- Issue [#51](https://github.com/DocForum/docforum-escrow/issues/51)
