---
file: README.md
after: "await client.accept({ escrowId: gated, payee });   // payer can no longer cancel"
---
await client.transferPayee({ escrowId, currentPayee: payee, newPayee }); // payee rotates wallets; newPayee must not be the payer or the contract id, and on a notifyPayee escrow must implement the callback
