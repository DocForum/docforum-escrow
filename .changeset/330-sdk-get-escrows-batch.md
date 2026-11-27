---
"@docforum/escrow-sdk": minor
---

Add `EscrowClient.getEscrows(ids)` (issue #330) to fetch many escrows in batched `getLedgerEntries` RPC calls (up to 200 keys per call) and decode them with `decodeEscrowDataFromScVal`, returning `Map<bigint, Escrow | undefined>` and throwing `ArchivedEntryError` if an entry's TTL has expired.
