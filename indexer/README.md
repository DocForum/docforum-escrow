# DocForum escrow event indexer

This SubQuery project indexes the escrow contract's `created`, `released`,
`refunded` and `cancelled` snapshots, plus the narrower events that change one
field of a stored escrow without republishing a snapshot (`pay_xfer`, `rotate`,
`top_up`, `accepted`, `contrib`, `claimed`). SubQuery owns its cursor and
canonical-chain rollback behavior; unknown event topics are ignored. No endpoint
is deployed or hardcoded for consumers. Run your own indexer against Stellar
testnet.

## Pin and codegen policy

The SubQuery packages and the runner versions in `project.ts` are pinned to
exact versions: no `*` and no ranges. `package-lock.json` is committed, so a
build resolves the same tree everywhere. Bump the four versions together
(`package.json` devDependencies and the two constants in `project.ts`) and
commit the regenerated lockfile in the same PR.

The generated entity classes under `src/types/` and the generated
`project.yaml` are **not** committed: `subql codegen` writes them, and CI runs
codegen before building. Run it yourself after changing `schema.graphql` or
`project.ts`:

```sh
npm run codegen
```

The mapping imports its entities through `src/entities.ts`, which re-exports
`./types`, so the mapping has one entity dependency that unit tests can replace
with in-memory fakes. `src/subql-globals.d.ts` pulls in SubQuery's ambient
`store`/`logger` declarations that the generated entities reference.

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

// Everything a given address is the payer or payee of:
const mine = await indexer.listEscrows({ payer: address, first: 50 });
```

Pass `payer` and/or `payee` to restrict a page to one address's escrows
(ADR 0015). Both filter the `Escrow` entity's existing fields, so the indexer
needs no change; there is no on-chain `list_by_payer` / `list_by_payee`.

Do not point this project at mainnet before the repository's security review.

## GraphQL entities

`Escrow` contains the latest state. `EscrowEvent` retains each state transition
with its transaction hash and ledger.

Lifecycle snapshots include the complete current escrow record, including the
releaser set, quorum threshold, callback/acceptance flags and acceptance
timestamp. Each non-lifecycle event updates only the field it carries:

| Topic | Payload | Field updated |
|---|---|---|
| `pay_xfer` | `(old_payee, new_payee)` | `payee` |
| `rotate` | `(old_releaser, new_releaser)` | `releasers` |
| `top_up` | `(amount, updated_amount)` | `amount` |
| `accepted` | `(payee, accepted_at)` | `acceptedAt` |
| `contrib` | `(payer, amount, funded)` | `amount` (new funded total) |
| `claimed` | `(contributor, refund_amount)` | `amount` (less the refund) |

`updatedLedger` records the ledger of the last applied change. An event older
than that ledger (a replay or an out-of-order delivery) is recorded in
`EscrowEvent` history but never overwrites newer fields. Events for an escrow
created before the indexer's start ledger have no stored record, so they are
skipped rather than creating a partial one: set the start ledger no later than
the contract deployment.

## Tests

```sh
npm test
```

Vitest, fully offline: `tests/mappings.test.ts` covers both the 12- and 13-field
snapshot layouts, every non-lifecycle handler, the ordering guard, the
missing-record skip and malformed payloads, using in-memory fakes for the
generated entities.
