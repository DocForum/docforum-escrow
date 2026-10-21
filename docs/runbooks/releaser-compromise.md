# Releaser compromise response

1. **Detect:** alert on unexpected release/refund transactions and rotate the compromised signer. Preserve transaction hashes and the affected contract ID.
2. **Contain:** stop new escrows using the key; do not guess outcomes. Export funded escrow IDs and have the payer or service owner approve an outcome for each.
3. **Settle:** run `scripts/settle-outcomes.py` with the signed outcome file. The tool is resumable and records successful transaction hashes; it never chooses release versus refund.
4. **Verify:** reconcile every funded escrow and confirm destinations match stored payee/refund_to.
5. **Review:** rotate keys, document the timeline, and retain the old deployment ID for reconciliation.

Outcome file format:
```json
{"escrows": [{"id": 12, "action": "release"}, {"id": 13, "action": "refund"}]}
```

The drill must use testnet only; record the number of escrows, elapsed time, failed submissions, and resume point here after execution.
