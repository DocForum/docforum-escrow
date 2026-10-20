# Browser demo

A minimal Vite + React app showing:

- `useEscrow`, `useEscrowActions` and `useEscrowTimeline` from
  `@docforum/escrow-react` (issue #126)
- `WalletsKitSigner` from `@docforum/escrow-sdk/signers/wallets-kit` (issue #127)
- `EscrowClient` telemetry via `onEvent` (issue #129, see `src/main.tsx`)

Testnet only. Nothing here is published; it exists to keep the integrator
surface honest.

```bash
cd examples/web-demo
npm install
VITE_ESCROW_CONTRACT_ID=C... npm run dev
```

`VITE_RPC_URL` is optional and defaults to the SDK's Soroban testnet RPC.

The demo deliberately keeps wallet wiring in one file (`src/wallet.ts`). The
SDK has no runtime import of Stellar Wallets Kit, so a server importing
`@docforum/escrow-sdk` never pulls wallet code.
