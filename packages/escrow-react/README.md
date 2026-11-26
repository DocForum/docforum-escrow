# @docforum/escrow-react

React hooks for [`@docforum/escrow-sdk`](../../sdk) — escrow state, actions,
live events and a refund deadline countdown. **Hooks only**: no components, no
styling, no contract logic.

```bash
npm install @docforum/escrow-react @docforum/escrow-sdk @tanstack/react-query react
```

`@docforum/escrow-sdk` is an **optional peer**: the hooks import only its types
(the client is injected, so there is no runtime SDK import), but you will
normally install it to create that client. When working inside this repo,
build the SDK once before `npm run typecheck`/`npm run build` so TypeScript can
resolve its declarations:

```bash
cd ../../sdk && npm ci && npm run build
```

## Setup

The hooks use [TanStack Query](https://tanstack.com/query) (React Query v5), so
mount them inside your existing `QueryClientProvider`. `EscrowProvider` only
supplies the client — it renders no DOM.

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EscrowClient } from "@docforum/escrow-sdk";
import { EscrowProvider } from "@docforum/escrow-react";

const queryClient = new QueryClient();
const client = new EscrowClient({ contractId });

export function Root() {
  return (
    <QueryClientProvider client={queryClient}>
      <EscrowProvider client={client} clientKey={contractId}>
        <App />
      </EscrowProvider>
    </QueryClientProvider>
  );
}
```

## `useEscrow(id)`

Fetches `getEscrow(id)` and polls while the escrow is still settling. Polling
**stops automatically** when the status is terminal — `Released`, `Refunded`
or `Cancelled` (payer withdrawal before acceptance) — and an escrow that is
already terminal is never polled. Pass `pollIntervalMs={0}` to disable polling
entirely.

```tsx
const { data: escrow, isPending, error } = useEscrow(escrowId);
```

## `useEscrowActions(signer)`

```tsx
const {
  release,
  refund,
  createEscrow,
  accept,
  cancel,
  topUp,
  contribute,
  claimRefund,
  isPending,
  error,
} = useEscrowActions(signer);

const result = await release(escrowId);
if (result.status === "rejected") {
  // The user closed the wallet prompt — not an error.
}
if (result.status === "precondition") {
  // The SDK refused before submitting; branch on result.error.code.
  console.log(result.error.code); // e.g. "AlreadyAccepted", "NotFunded"
}
```

- Creates use the signer as `payer`; release/refund/top-up use it as `caller`
  or `payer`.
- `accept` uses the signer as the escrow's **payee**; `cancel` uses it as the
  **payer**; `topUp(escrowId, amount)` adds funds as the original payer.
  `contribute(escrowId, amount)` funds a pooled escrow as the payer and
  `claimRefund(escrowId)` pulls the signer's own contribution back from a
  failed pool.
- `releaseWithApprovals` / `refundWithApprovals` default to `[signer]`.
- A successful call invalidates the matching query (`useEscrow`'s detail
  entry, plus both `usePooledEscrow` and `useContribution` for the pooled
  actions), so status, phase and timeline update without extra wiring.
- A wallet rejection resolves as `{ status: "rejected" }`. A client-side
  `EscrowPreconditionError` resolves as
  `{ status: "precondition", error: { name, code, method, message } }`, so a
  predictable refusal is typed state rather than an exception. Every other
  failure rejects and is available as `error`.
- `signer` is a `Keypair` or any SEP-43 `Signer` — including
  `WalletsKitSigner` from `@docforum/escrow-sdk/signers/wallets-kit`.

## `usePooledEscrow(id)` and `useContribution(id, address)`

A pooled escrow funds one agreement from many payers. `usePooledEscrow` reads
the escrow record together with its funding config (`getEscrow` +
`getPooled`) and derives the funding phase; it polls until the phase is
settled.

```tsx
const { phase, escrow, pooled, isSettled, isPending } = usePooledEscrow(escrowId);
const { data: myContribution } = useContribution(escrowId, address);
```

### Phase semantics

A failed round stays `Funded` on-chain, so **status alone cannot drive
polling**. The phase is derived with the contract's boundary rules:

| Phase      | Meaning                                                                 |
| ---------- | ----------------------------------------------------------------------- |
| `open`     | `amount < fundingTarget` and ledger time is before `fundingDeadline`.   |
| `funded`   | `amount >= fundingTarget`; the releaser may release at any time, deadline or not. |
| `failed`   | The deadline passed below the target (contributions frozen, `claimRefund` open forever), or the round already closed as `Refunded`/`Cancelled`. |
| `released` | The escrow settled as `Released`; the payout is final.                  |

`isSettled` is true for `failed` and `released`, and **polling stops there**.
`fundingDeadline` is a ledger timestamp: pass `now: () => latestLedgerCloseTime`
for a phase that matches the contract, or accept local-clock drift (the
default). `pollIntervalMs={0}` disables polling.

`useContribution` returns the signer's recorded total (`{ amount, refunded }`)
or `undefined` when the address never contributed. It is held while the
address is empty, does not poll, and is invalidated by `contribute` /
`claimRefund`.

## `useEscrowEvents({ escrowId?, types?, cursor? })`

A live activity feed backed by `client.subscribe`, with subscription lifecycle
management and bounded memory.

```tsx
const { events, cursor, error, cursorExpired, subscribed, clear } = useEscrowEvents({
  escrowId,
  types: ["created", "released", "refunded", "cancelled"],
  cursor: savedCursor, // resume where you stopped
  maxEvents: 50,       // keep the 50 most recent (default 100)
});

localStorage.setItem("escrow-cursor", cursor ?? "");
```

- Starts one subscription per client/filter/cursor/interval and stops it on
  unmount or when any of those change. React StrictMode's mount → unmount →
  mount leaves **exactly one** live subscription.
- `events` is oldest-first and capped at `maxEvents`; `cursor` is the last
  delivered event's cursor, ready to persist and resume from.
- Each event invalidates the matching `useEscrow`/`usePooledEscrow` query for
  the escrow it names, so details stay in sync with the feed.
- An expired cursor (`EventCursorExpiredError`) surfaces as `error` /
  `cursorExpired` state, never a thrown render error. Resume without `cursor`
  to start from the latest ledger.
- `subscribed` reflects whether a subscription is running; `clear()` empties
  the buffer without touching the subscription.

## `useEscrowTimeline(escrow)`

```tsx
const { data } = useEscrow(escrowId);
const { remainingMs, expired, isTerminal } = useEscrowTimeline(data, {
  ledgerTimeOffsetMs: latestLedgerCloseTimeMs - Date.now(),
});
```

### Ledger time vs local time

`refundAfter` is a **ledger timestamp** (unix seconds from Stellar's ledger
close time). The contract compares it to ledger time, not your machine's
clock, so a client-side countdown is advisory:

- Local clock drift can make the countdown disagree with the contract by
  seconds or minutes.
- The countdown reaching zero does **not** authorize a refund by itself; the
  contract still decides. Anyone may refund after the deadline, and only back
  to the payer.
- Pass `ledgerTimeOffsetMs` (ledger close time minus local time) to align the
  display. Without it, the hook assumes the local clock.

The timer stops when the deadline passes or the escrow becomes terminal
(`Released`, `Refunded`, `Cancelled`). The hook fetches nothing itself.

## Notes

- Bigints stay bigints; `refundAfter` is converted to milliseconds only for
  display arithmetic.
- All caching is standard React Query: use `escrowKeys` with
  `queryClient.invalidateQueries` / `setQueryData` if you need manual control.
  Keys for one escrow share the `detail` prefix (`detail`, `pooled`,
  `contribution`, `contributions`), so invalidating `detail` refreshes every
  view of that escrow.
- `EscrowClientLike.subscribe` is optional: the query and action hooks work
  with any partial client, and only `useEscrowEvents` needs `subscribe`.
- Testnet only, consistent with the SDK and `ARCHITECTURE_ESSENTIALS.md`.
