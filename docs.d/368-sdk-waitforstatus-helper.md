---
file: README.md
section: How it's used
---
### `waitForStatus` helper for settlement confirmation

Integrators that hand settlement to another party (a relayer, an M-of-N
quorum, a payee that accepts first) need to wait until an escrow reaches a
given status, and each one otherwise writes its own `getStatus` polling loop
with its own timeout and cleanup bugs.

`client.waitForStatus(escrowId, statuses, { timeoutMs, pollIntervalMs, signal })`
polls until the status is one of `statuses` and resolves with
`{ escrowId, status }` — not a full escrow, since a settled escrow's record is
reclaimed ([ADR 0013](docs/adr/0013-reclaim-storage-for-settled-escrows.md)). It
rejects with a typed `WaitTimeoutError` on timeout, and also when the escrow
settles on a terminal status outside the target set (for example, waiting for
`Released` but it is now `Refunded`); `lastStatus` holds the last status seen.
An unknown escrow id rejects immediately with the same `NotFoundError`
`getStatus` raises, and an aborted `signal` rejects with the signal's reason
(an `AbortError` by default).

```ts
import { EscrowClient, WaitTimeoutError } from "@docforum/escrow-sdk";

const client = new EscrowClient({ contractId: "C…" });

const controller = new AbortController();
try {
  const { status } = await client.waitForStatus(escrowId, ["Released"], {
    timeoutMs: 30_000,
    pollIntervalMs: 2_000,
    signal: controller.signal,
  });
  console.log(`escrow ${escrowId} is ${status}`);
} catch (error) {
  if (error instanceof WaitTimeoutError) {
    // `undefined` when no read completed before the deadline.
    console.log(`timed out; last status: ${error.lastStatus ?? "unknown"}`);
  } else if (error instanceof DOMException && error.name === "AbortError") {
    console.log("cancelled");
  }
}
```

No timer or pending poll survives resolution, rejection or abort, so a helper
call never keeps a Node process alive. Offline tests with fake timers cover
resolution, timeout (including while a status read is in flight),
terminal-status mismatch, abort, and an unknown escrow id.
