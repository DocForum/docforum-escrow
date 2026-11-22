# Static escrow explorer

Read-only, testnet-only browser page for inspecting a `docforum-escrow` contract
and escrow ID. It reads escrow terms, token metadata, retained lifecycle events,
and settlement status through Soroban RPC; it never asks for a wallet, keys, or
signing authority.

```bash
npm install
npm run dev
```
