---
file: ARCHITECTURE_ESSENTIALS.md
after: "client.signAuthEntries(preparedXdr, keypair, { validUntilLedger? }); // when source != releaser; returns { xdr, hash, signedEntries }"
---
client.canRelease({ escrowId, caller });      // { ok, reasons } — no signature, no transaction; reasons[0] is the contract's error (issue #332)
client.canRefund({ escrowId, caller });       // { ok, reasons } — also covers the payee-voluntary and timeout refund paths
