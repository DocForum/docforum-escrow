---
file: README.md
after: "retry it after its expiration ledger."
---
Rotating a single releaser needs auth from both the current releaser and the
payer, usually on different machines. `prepareRotateReleaser` simulates the
call for a submitter that holds neither key; each party signs only its own
`rotate_releaser` auth entry; the submitter merges the copies and sends:

```ts
const rotation = await client.prepareRotateReleaser({ escrowId, newReleaser, source: submitter.publicKey() });
const byReleaser = await releaserClient.signRotationAuth(rotation, releaser);
const byPayer = await payerClient.signRotationAuth(rotation, payer);
const { txHash } = await client.submitRotation([byReleaser, byPayer], submitter);
```

Both signatures expire at `rotation.expiresAtLedger`; `signRotationAuth` and
`submitRotation` throw `AuthorizationExpiredError` once it has passed.
