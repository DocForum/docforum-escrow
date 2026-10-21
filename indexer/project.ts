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

const project: StellarProject = {
  specVersion: "1.0.0",
  name: "docforum-escrow-indexer",
  version: "0.1.0",
  runner: {
    node: { name: "@subql/node-stellar", version: "*" },
    query: { name: "@subql/query", version: "*" },
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
        ],
      },
    },
  ],
};

export default project;
