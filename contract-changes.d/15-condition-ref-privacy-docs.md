bump: patch
---
Issue #15: doc comments only. `condition_ref` on `EscrowData` and `create_escrow` now warns that it is public on-chain forever and must be an opaque id (docs/threat-model.md T9). No behaviour or interface change; the SDK bindings pick up the new doc text.
