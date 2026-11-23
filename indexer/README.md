# DocForum escrow event indexer

This SubQuery project indexes the escrow contract's `created`, `released`,
`refunded` and `cancelled` snapshots. SubQuery owns its cursor and canonical-chain rollback
behavior; unknown event topics are ignored. No endpoint is deployed or
hardcoded for consumers: testnet is the default, and local quickstarts or
futurenet are configured with environment variables.

## Configure and run

Set `DOCFORUM_ESCROW_CONTRACT_ID` to the contract you deployed and
`DOCFORUM_START_LEDGER` to its deployment ledger. The network is chosen with:

| Variable | Meaning | Default |
| --- | --- | --- |
| `DOCFORUM_NETWORK_PASSPHRASE` | Exact passphrase used as the SubQuery `chainId` | Testnet (`Test SDF Network ; September 2015`) |
| `DOCFORUM_HORIZON_URL` | Archive-capable Horizon endpoint | `https://horizon-testnet.stellar.org` |
| `DOCFORUM_RPC_URL` | Soroban RPC endpoint | `https://soroban-testnet.stellar.org` |
| `DOCFORUM_ALLOW_MAINNET` | Opt-in for the public passphrase | unset |

Set the passphrase and both endpoint variables for a non-testnet network; the
endpoint defaults stay testnet so a misspelled variable name cannot silently
move the indexer to a different network. Then run:

```sh
npm install
npm run codegen
npm run build
npm run start -- --db-host localhost --db-user postgres --db-pass postgres
```

Run a local PostgreSQL instance before starting the node, then run
`npm run query` in a second terminal. The query service exposes GraphQL at
`http://localhost:3000`. Pass its URL to `EscrowIndexerClient`:

```ts
import { EscrowIndexerClient } from "@docforum/escrow-sdk";

const indexer = new EscrowIndexerClient({ endpoint: process.env.ESCROW_INDEXER_URL! });
const page = await indexer.listEscrows({ first: 50 });

// Everything a given address is the payer or payee of:
const mine = await indexer.listEscrows({ payer: address, first: 50 });
```

Pass `payer` and/or `payee` to restrict a page to one address's escrows
(ADR 0015). Both filter the `Escrow` entity's existing fields, so the indexer
needs no change; there is no on-chain `list_by_payer` / `list_by_payee`.

### Local quickstart

A local quickstart is just another passphrase and pair of endpoints. For the
standard `stellar/quickstart --local` container (Horizon on port 8000, RPC at
`/rpc`):

```sh
docker run --rm -d -p 8000:8000 stellar/quickstart --local

export DOCFORUM_NETWORK_PASSPHRASE="Standalone Network ; February 2017"
export DOCFORUM_HORIZON_URL="http://localhost:8000"
export DOCFORUM_RPC_URL="http://localhost:8000/rpc"
export DOCFORUM_ESCROW_CONTRACT_ID="<deployed contract id>"
export DOCFORUM_START_LEDGER=<deployment ledger>
```

Use the quickstart's RPC path if yours differs (some versions expose
`/soroban/rpc`). Point `DOCFORUM_ESCROW_CONTRACT_ID` at the contract deployed
to that quickstart — `scripts/deploy --dry-run` records one locally without
touching tracked files. No source edit is needed to switch networks.

### Mainnet guard

The public passphrase (`Public Global Stellar Network ; September 2015`) and
the public-network endpoints (`horizon.stellar.org`, `soroban.stellar.org`,
or any host labelled `mainnet`/`pubnet`) are refused at project load unless
`DOCFORUM_ALLOW_MAINNET` is exactly `true`. Values such as `1`, `yes`, `TRUE`
or `true ` do not count, surrounding whitespace in the passphrase or endpoint
values is ignored, and a typo in either variable name leaves the testnet
default in place. This mirrors the SDK's `allowMainnet` opt-in and enforces
hard rule 4.

Do not point this project at mainnet before the repository's security review.

## GraphQL entities

`Escrow` contains the latest lifecycle snapshot. `EscrowEvent` retains each
state transition with its transaction hash and ledger. The indexer replays
events from the configured start ledger, so set that ledger no later than
the contract deployment.

Lifecycle snapshots include the complete current escrow record, including the releaser set, quorum threshold, callback/acceptance flags and acceptance timestamp.
