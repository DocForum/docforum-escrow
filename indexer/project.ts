import {
  StellarDatasourceKind,
  StellarHandlerKind,
  type StellarProject,
} from "@subql/types-stellar";

const contractId = process.env.DOCFORUM_ESCROW_CONTRACT_ID;
const startBlock = Number(process.env.DOCFORUM_START_LEDGER);
if (!contractId) throw new Error("Set DOCFORUM_ESCROW_CONTRACT_ID before building the indexer");
if (!Number.isSafeInteger(startBlock) || startBlock < 1) {
  throw new Error("Set DOCFORUM_START_LEDGER to the contract deployment ledger");
}

// Exact versions: keep in step with the devDependencies in package.json. The
// runner must not float to whatever upstream released last.
const NODE_STELLAR_VERSION = "6.2.1";
const QUERY_VERSION = "2.25.0";

// Lifecycle snapshots publish `(ESCROW, action, escrow_id)` and carry the whole
// escrow record. The other topics are narrower events emitted by calls that
// change one field without republishing a snapshot (issue #346):
//   pay_xfer  -> (escrow_id) (old_payee, new_payee)
//   rotate    -> (escrow_id) (old_releaser, new_releaser)
//   top_up    -> (escrow_id) (amount, updated_amount)
//   accepted  -> (escrow_id) (payee, accepted_at)
//   contrib   -> (escrow_id) (payer, amount, funded)
//   claimed   -> (escrow_id) (contributor, refund_amount)
const PARTIAL_TOPICS = ["pay_xfer", "rotate", "top_up", "accepted", "contrib", "claimed"] as const;

const project: StellarProject = {
  specVersion: "1.0.0",
  name: "docforum-escrow-indexer",
  version: "0.1.0",
  runner: {
    node: { name: "@subql/node-stellar", version: NODE_STELLAR_VERSION },
    query: { name: "@subql/query", version: QUERY_VERSION },
  },
  description: "Testnet-only indexer for DocForum escrow lifecycle events",
  schema: { file: "./schema.graphql" },
  network: {
    chainId: "Test SDF Network ; September 2015",
    endpoint: [process.env.DOCFORUM_HORIZON_URL ?? "https://horizon-testnet.stellar.org"],
    sorobanEndpoint: process.env.DOCFORUM_RPC_URL ?? "https://soroban-testnet.stellar.org",
  },
  dataSources: [
    {
      kind: StellarDatasourceKind.Runtime,
      startBlock,
      mapping: {
        file: "./dist/index.js",
        handlers: [
          {
            handler: "handleEscrowEvent",
            kind: StellarHandlerKind.Event,
            filter: {
              contractId,
              topics: ["ESCROW"],
            },
          },
          ...PARTIAL_TOPICS.map((topic) => ({
            handler: "handleEscrowEvent",
            kind: StellarHandlerKind.Event,
            filter: {
              contractId,
              topics: [topic],
            },
          })),
        ],
      },
    },
  ],
};

export default project;
