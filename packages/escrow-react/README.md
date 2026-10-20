# @docforum/escrow-react

React hooks for [`@docforum/escrow-sdk`](../../sdk) — escrow state, actions and
a refund deadline countdown. **Hooks only**: no components, no styling, no
contract logic.

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
**stops automatically** when the status becomes `Released` or `Refunded`, and
an escrow that is already terminal is never polled. Pass
`pollIntervalMs={0}` to disable polling entirely.

```tsx
const { data: escrow, isPending, error } = useEscrow(escrowId);
```

## `useEscrowActions(signer)`

```tsx
const { release, refund, createEscrow, isPending, error } = useEscrowActions(signer);

const result = await release(escrowId);
if (result.status === "rejected") {
  // The user closed the wallet prompt — not an error.
}
```

- Creates use the signer as `payer`; release/refund use it as `caller`.
- `releaseWithApprovals` / `refundWithApprovals` default to `[signer]`.
- A successful call invalidates the matching `useEscrow` query, so the status
  and timeline update without extra wiring.
- A wallet rejection resolves as `{ status: "rejected" }`; all other failures
  reject and are available as `error`.
- `signer` is a `Keypair` or any SEP-43 `Signer` — including
  `WalletsKitSigner` from `@docforum/escrow-sdk/signers/wallets-kit`.

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

The timer stops when the deadline passes or the escrow becomes terminal. The
hook fetches nothing itself.

## Notes

- Bigints stay bigints; `refundAfter` is converted to milliseconds only for
  display arithmetic.
- All caching is standard React Query: use `escrowKeys` with
  `queryClient.invalidateQueries` / `setQueryData` if you need manual control.
- Testnet only, consistent with the SDK and `ARCHITECTURE_ESSENTIALS.md`.
