### Added

- SDK: typed decoding of non-lifecycle contract events. `EscrowEvent` now includes discriminated variants for `topUp`, `accepted`, `rotated`, `payeeTransferred`, `contributed`, `claimed`, `payeeRefunded`, `paused`, and `unpaused`, each with decoded fields (for example `{ type: "payeeTransferred", escrowId, oldPayee, newPayee }`). `getEvents` and `subscribe` accept these new types in their `types` filter.

### Compatibility

- Minor, non-breaking change. Unknown future events still decode as `type: "unknown"`. Consumers whose `switch` statements on `EscrowEvent["type"]` have a `default` branch continue to compile. Consumers with exhaustive switches without a default must add the new cases.
