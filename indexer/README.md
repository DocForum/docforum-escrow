# DocForum escrow event indexer

This SubQuery project indexes the escrow contract's `created`, `released`,
`refunded` and `cancelled` snapshots. SubQuery owns its cursor and canonical-chain rollback
behavior; unknown event topics are ignored. No endpoint is deployed or
hardcoded for consumers. Run your own indexer against Stellar testnet.

## Configure and run

Set `DOCFORUM_ESCROW_CONTRACT_ID` to the contract you deployed,
`DOCFORUM_START_LEDGER` to its deployment ledger, and optionally provide
`DOCFORUM_HORIZON_URL` and `DOCFORUM_RPC_URL` for archive-capable testnet
endpoints. Then run:

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
```

Do not point this project at mainnet before the repository's security review.

## GraphQL entities

`Escrow` contains the latest lifecycle snapshot. `EscrowEvent` retains each
state transition with its transaction hash and ledger. The indexer replays
events from the configured start ledger, so set that ledger no later than
the contract deployment.

Lifecycle snapshots include the complete current escrow record, including the releaser set, quorum threshold, callback/acceptance flags and acceptance timestamp.
