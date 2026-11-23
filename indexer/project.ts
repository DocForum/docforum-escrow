import {
  StellarDatasourceKind,
  StellarHandlerKind,
  type StellarProject,
} from "@subql/types-stellar";
// Extensionless: project.ts is loaded through ts-node (CommonJS), not compiled
// with src/, so a `.js` specifier would not resolve at project load time.
import { resolveNetworkConfig } from "./src/network";

const contractId = process.env.DOCFORUM_ESCROW_CONTRACT_ID;
const startBlock = Number(process.env.DOCFORUM_START_LEDGER);
if (!contractId) throw new Error("Set DOCFORUM_ESCROW_CONTRACT_ID before building the indexer");
if (!Number.isSafeInteger(startBlock) || startBlock < 1) {
  throw new Error("Set DOCFORUM_START_LEDGER to the contract deployment ledger");
}

const network = resolveNetworkConfig();

const project: StellarProject = {
  specVersion: "1.0.0",
  name: "docforum-escrow-indexer",
  version: "0.1.0",
  runner: {
    node: { name: "@subql/node-stellar", version: "*" },
    query: { name: "@subql/query", version: "*" },
  },
  description: "Configurable-network indexer for DocForum escrow lifecycle events (testnet default)",
  schema: { file: "./schema.graphql" },
  network: {
    chainId: network.chainId,
    endpoint: [network.horizonUrl],
    sorobanEndpoint: network.rpcUrl,
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
