# Archived contract entries

Soroban can archive persistent contract entries after their storage TTL expires. The SDK exposes two behaviors through `EscrowClientConfig.archivalBehavior`:

- `"error"` (default) leaves restoration to the caller and throws `ArchivedEntryError` when an invocation requires archived state.
- `"auto"` enables the Stellar SDK's restore preamble handling. The SDK restores the required footprint and retries the original invocation once.

```ts
const client = new EscrowClient({
  contractId,
  archivalBehavior: "auto",
  // Needed when a read-only call encounters archived state.
  restoreSigner: restoreAccount,
});

const escrow = await client.getEscrow(escrowId);
```

For state-changing methods, the method's signer (`payer` or `caller`) signs and pays the restore transaction. Read-only methods need no signer for ordinary simulation; in automatic mode, provide `restoreSigner` to authorize and pay for a required restore. If that signer is missing or restoration fails, the SDK throws `ArchivedEntryError` with the method name and original cause. Keep enough XLM available for Soroban resource fees and the storage reserve required by the restore transaction.

Automatic restoration is limited to the SDK's one restore attempt and one retry of the original call. If the retry still reports archived state, the error is returned to the caller; the client does not loop.
