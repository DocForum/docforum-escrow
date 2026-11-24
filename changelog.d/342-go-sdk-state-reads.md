Issue #342 (Phase E6): the Go SDK gained `Version`, `IsPaused`,
`GetPauseAdmin` and `Solvency` reads and an optional
`Config.ContractVersionCheck` (off by default, `Auto` or `Required`) that
verifies `version()` against the same `>=2.0.0 <4.0.0` range as the TypeScript
SDK before the first write. A deployment without `version()` reports
`*VersionUnavailableError`; an out-of-range one reports
`*UnsupportedContractVersionError`. New offline tests drive the client through
a fake RPC. No contract change; additive Go API.
