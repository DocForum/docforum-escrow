---
file: ROADMAP.md
section: Phase E6 — SDK & integrator tooling
---
- [x] Configurable indexer network (issue #348): `DOCFORUM_NETWORK_PASSPHRASE`
  (testnet default) plus the existing Horizon/RPC env vars select the network
  without a source edit; the public passphrase needs an exact
  `DOCFORUM_ALLOW_MAINNET=true` opt-in. Local quickstart usage documented in
  `indexer/README.md`.
