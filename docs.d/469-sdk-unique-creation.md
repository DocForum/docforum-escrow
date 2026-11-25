---
file: README.md
section: Lifecycle amendments
---
### Retry-safe creation

A backend that retries "fund order X" after a timeout must not lock funds
twice. Pass `unique: true` to make creation idempotent per `(payer,
conditionRef)` (contract #47, SDK issue #469):

```ts
const result = await client.createEscrow({ ...params, conditionRef: "order-42", unique: true });
if (result.existing) {
  // A previous attempt already created it: no transaction was sent.
  console.log(`escrow ${result.escrowId} already exists (${result.status})`);
} else {
  console.log(`created escrow ${result.escrowId} in ${result.txHash}`);
}
const id = await client.getUniqueEscrow(payer, "order-42"); // bigint | undefined
```

A duplicate is detected whether it shows up at simulation or after submission,
for example when a resubmitted transaction has already landed. The existing
escrow's payee, token and amount are checked against the request, and a
mismatch throws `UniqueEscrowMismatchError` rather than reporting success.
Once the escrow settles, its record is reclaimed but the index survives, so a
retry still returns `existing: true` with the terminal `status` (the terms
can't be checked then). The index is per payer. `unique` can't be combined
with `requiresAcceptance`, `releaseNotBefore` or quorum options. Without
`unique`, `createEscrow` sends exactly what it always has.
