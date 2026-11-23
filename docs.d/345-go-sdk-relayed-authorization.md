---
file: ROADMAP.md
section: Phase E6 — SDK & integrator tooling
---
- [x] Go SDK relayed release/refund authorization (issue #345):
  `AuthorizeRelease` / `AuthorizeRefund` return a portable
  `RelayedAuthorization` whose `transaction` JSON is the TypeScript SDK's
  `RelayedAuthorization.transaction` format, so either SDK can produce an
  authorization and the other submit it. `SubmitRelayed` rejects expired
  authorizations, a settlement that does not match the envelope, anything other
  than exactly one `invokeContract` call to this contract, and a submitter that
  is not the envelope's relayer. Cross-SDK fixture and separate-relayer tests.
