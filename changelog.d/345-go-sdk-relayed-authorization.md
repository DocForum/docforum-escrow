Issue #345 (Phase E6): the Go SDK can now relay settlements.
`AuthorizeRelease` / `AuthorizeRefund` sign only the releaser's short-lived auth
entry and return a `RelayedAuthorization` in the TypeScript SDK's
`RelayedAuthorization.transaction` JSON format, and `SubmitRelayed` has a
separate relayer sign the envelope and submit. Expired authorizations
(`ErrAuthorizationExpired`), a mismatched settlement, an envelope that is not
exactly one `invokeContract` call to this contract, and a submitter that is not
the envelope's relayer are all rejected client-side. Tests cover a Go-produced
authorization submitted by a second keypair and a TypeScript-shaped fixture. No
contract change; additive Go API.
