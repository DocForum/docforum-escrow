import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  KNOWN_DEPLOYMENTS,
  UnknownDeploymentError,
  knownContractId,
  knownNetworkConfig,
  latestDeployment,
  parseDeployments,
  type DeploymentRecord,
  type DeploymentsDocument,
} from "../src/index.js";

const CONTRACT_A = `C${"A".repeat(55)}`;
const CONTRACT_B = `C${"B".repeat(55)}`;

function record(overrides: Partial<DeploymentRecord> = {}): DeploymentRecord {
  return {
    network: "testnet",
    networkPassphrase: "Test SDF Network ; September 2015",
    rpcUrl: "https://soroban-testnet.stellar.org",
    contractId: CONTRACT_A,
    wasmHash: "a".repeat(64),
    gitSha: "0".repeat(40),
    deployedAt: "2026-10-24T00:00:00.000Z",
    uploadTxHash: "1".repeat(64),
    deployTxHash: "2".repeat(64),
    allowedTokens: [],
    verification: [
      { case: "create", result: "Passed", escrowId: 0, txHash: "3".repeat(64), expected: "Funded" },
    ],
    ...overrides,
  };
}

const doc = (...deployments: DeploymentRecord[]): DeploymentsDocument => ({
  version: 1,
  deployments,
});

describe("deployment records", () => {
  it("bundles exactly the repo-root deployments.json", () => {
    const rootJson = readFileSync(
      fileURLToPath(new URL("../../deployments.json", import.meta.url)),
      "utf8",
    );
    expect(KNOWN_DEPLOYMENTS).toEqual(JSON.parse(rootJson));
    expect(() => parseDeployments(rootJson)).not.toThrow();
  });

  it("resolves the newest verified record for a network", () => {
    const deployments = doc(record(), record({ contractId: CONTRACT_B }));
    expect(knownContractId("testnet", deployments)).toBe(CONTRACT_B);
    expect(knownNetworkConfig("testnet", deployments)).toEqual({
      contractId: CONTRACT_B,
      rpcUrl: "https://soroban-testnet.stellar.org",
      networkPassphrase: "Test SDF Network ; September 2015",
    });
  });

  it("skips records whose verification did not fully pass", () => {
    const failed = record({
      contractId: CONTRACT_B,
      verification: [
        { case: "release", result: "Failed", escrowId: 0, txHash: null, expected: "Released" },
      ],
    });
    expect(latestDeployment("testnet", doc(record(), failed)).contractId).toBe(CONTRACT_A);
    expect(() => latestDeployment("testnet", doc(record({ verification: [] })))).toThrow(
      UnknownDeploymentError,
    );
  });

  it("fails loudly for unknown networks and refuses mainnet", () => {
    expect(() => knownContractId("futurenet", doc(record()))).toThrow(UnknownDeploymentError);
    expect(() => knownContractId("mainnet", doc(record()))).toThrow(/Mainnet is not supported/);
  });

  it("rejects malformed or mainnet documents", () => {
    expect(() => parseDeployments({ deployments: [] })).toThrow(TypeError);
    expect(() => parseDeployments(doc(record({ contractId: "GABC" })))).toThrow(/contractId/);
    expect(() => parseDeployments(doc(record({ wasmHash: "xyz" })))).toThrow(/wasmHash/);
    expect(() => parseDeployments(doc(record({ network: "mainnet" })))).toThrow(/Mainnet/);
    expect(() =>
      parseDeployments(
        doc(record({ networkPassphrase: "Public Global Stellar Network ; September 2015" })),
      ),
    ).toThrow(/mainnet/);
    expect(parseDeployments(JSON.stringify(doc(record())))).toEqual(doc(record()));
  });
});
