Issue #327 (Phase E6): the SDK decodes every non-lifecycle contract event
into a typed `EscrowEvent` variant instead of `type: "unknown"`: `topUp`
(`amount`, `newAmount`), `accepted` (`payee`, `acceptedAt`), `rotated`
(`oldReleaser`, `newReleaser`), `payeeTransferred` (`oldPayee`, `newPayee`),
`contributed` (`contributor`, `amount`, `funded`), `claimed` (`contributor`,
`amount`), `payeeRefunded` (`payer`, `payee`, `amount`), `settled`
(`payeeAmount`, `payerAmount`), `refundDeadlineExtended` (`oldDeadline`,
`newDeadline`), and the contract-wide `paused`/`unpaused` (`admin`, no
`escrowId`). `getEvents` and `subscribe` accept the new names in `types`.
Unknown future events, and known names with an unexpected payload, still
decode as `type: "unknown"` without throwing. Recurring-schedule events are
no longer misread as escrow `created` events. Fixtures come from the
committed contract test snapshots where one exists. Minor, non-breaking SDK
change: a `switch` on `EscrowEvent["type"]` with a `default` branch keeps
compiling; an exhaustive switch without one must add the new cases. No
contract change, so the generated bindings are unchanged.
