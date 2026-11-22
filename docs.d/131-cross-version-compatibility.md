---
file: README.md
section: Project status
---
### SDK/contract compatibility

The `SDK/contract compatibility` workflow builds each `sdk-v*` contract tag,
deploys the artifacts to a local network, and exercises current-SDK reads and
settlement against those deployments. It also checks the last two SDK releases
against the current contract. Missing results fail the job, while
known-incompatible ABI pairs are listed explicitly.

| SDK release | Contract deployment | Result |
| --- | --- | --- |
| `sdk-v0.1.0` | `sdk-v0.1.0` | verified read/settle |
| `sdk-v0.1.0` | `sdk-v0.2.0` | verified read/settle |
| `sdk-v0.1.0` | `main` | known-incompatible: legacy create ABI |
| `sdk-v0.2.0` | `sdk-v0.1.0` | verified read/settle |
| `sdk-v0.2.0` | `sdk-v0.2.0` | verified read/settle |
| `sdk-v0.2.0` | `main` | known-incompatible: legacy create ABI |
| `main` | `sdk-v0.1.0` | verified read/settle |
| `main` | `sdk-v0.2.0` | verified read/settle |
| `main` | `main` | verified read/settle |
