# Examples — `@docforum/escrow-sdk`

Runnable scripts, one per major flow, that exercise the SDK against the live
Stellar **testnet** escrow contract. They are the quickest way to see the SDK
work end to end, and they double as copy-paste starting points.

The generated API reference for every exported symbol is built by TypeDoc
(`npm run docs` in `sdk/`, config in `sdk/typedoc.json`) and published to
GitHub Pages.

## Safety

- **No secrets, ever.** Every keypair is generated at runtime and funded via
  testnet [Friendbot](https://developers.stellar.org/docs/learn/fundamentals/networks#friendbot).
  Nothing here reads or writes a private key from disk or the environment.
- **Testnet only** (hard rule 4). The defaults point at the testnet
  deployment; these scripts never touch mainnet.

## Run one

Requires **Node ≥ 22.6** (the examples are TypeScript run directly via Node's
built-in type stripping — no build step for the examples themselves).

```bash
cd sdk
npm install        # or npm ci
npm run build      # the examples import the SDK's built output in ../dist
node examples/create-and-release.ts
```

| Script | Flow |
|---|---|
| `node examples/create-and-release.ts` | Create a single-releaser escrow, confirm `Funded`, release to the payee. |
| `node examples/timeout-refund.ts` | Create with a short `refundAfter`, then let an unrelated account refund once it passes. |
| `node examples/quorum-release.ts` | Create a 2-of-3 quorum escrow, show one releaser can't settle alone, release with two approvals. |
| `node examples/fee-estimate-and-sponsor.ts` | Estimate a call, then prepare/sign a release, guard it, fee-bump it under a cap, and submit it as a sponsor. |

These in-repo scripts import the SDK's local build (`../dist`). In your own
project you would install the package and import it by name instead:

```ts
import { EscrowClient, Keypair } from "@docforum/escrow-sdk";
```

## Point at a different deployment

The contract id and token default to the deployment recorded in
[`../../docs/testnet-deployments.md`](../../docs/testnet-deployments.md).
Override them without editing code:

```bash
ESCROW_CONTRACT_ID=C... ESCROW_TOKEN=C... node examples/create-and-release.ts
```

`quorum-release` needs a deployment whose contract includes the M-of-N entry
points; point `ESCROW_CONTRACT_ID` at one if the default lacks them.

## CI

CI **type-checks** these examples on every PR (`npm run typecheck:examples`,
part of the `sdk-node` job in `.github/workflows/ci.yml`). It does not run them
— they depend on live testnet and Friendbot, the same reason the SDK's own live
suite is kept out of CI. Running them is a manual step.
