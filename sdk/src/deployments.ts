// Known contract deployments per network (issue #89).
//
// `scripts/deploy` records every deployment in the repo-root
// `deployments.json` and mirrors it into `deployments.generated.ts`, which is
// bundled with the SDK. Nothing here touches the filesystem or the network, so
// it works the same in Node, Deno, Bun and browsers.

import { KNOWN_DEPLOYMENTS } from "./deployments.generated.js";

/** Outcome of one scripted live-verification case. */
export interface DeploymentVerificationCase {
  /** Case name, e.g. `"release"` or `"reject_stranger_release"`. */
  case: string;
  result: "Passed" | "Failed";
  /** Escrow the case ran against, when it created or touched one. */
  escrowId: number | null;
  /** Submitted transaction, or `null` for a rejection caught in simulation. */
  txHash: string | null;
  /** What the case required, e.g. `"Released"` or `"Error(Contract, #3) Unauthorized"`. */
  expected: string;
}

/** One record written by `scripts/deploy`. */
export interface DeploymentRecord {
  /** `"testnet"`. Mainnet is never recorded. */
  network: string;
  networkPassphrase: string;
  rpcUrl: string;
  /** The deployed escrow contract's address (`C…`). */
  contractId: string;
  /** Hex SHA-256 of the deployed WASM, confirmed against the on-chain copy. */
  wasmHash: string;
  /** Full git commit the WASM was built from (clean tree). */
  gitSha: string;
  /** ISO-8601 time of the deployment. */
  deployedAt: string;
  /** `null` when the WASM was already on the network, so nothing was uploaded. */
  uploadTxHash: string | null;
  deployTxHash: string;
  /** Constructor token allowlist (`[]` allows any token). */
  allowedTokens: string[];
  verification: DeploymentVerificationCase[];
  explorer?: { contract: string; tx: string };
}

/** Shape of `deployments.json`: records in deployment order, newest last. */
export interface DeploymentsDocument {
  version: 1;
  deployments: DeploymentRecord[];
}

/** Thrown when no verified deployment is recorded for a network. */
export class UnknownDeploymentError extends Error {
  readonly network: string;
  constructor(network: string) {
    super(`No verified docforum-escrow deployment is recorded for network "${network}".`);
    this.name = "UnknownDeploymentError";
    this.network = network;
  }
}

const MAINNET_NAMES = new Set(["mainnet", "public", "pubnet"]);
const MAINNET_PASSPHRASE = "Public Global Stellar Network ; September 2015";

function assertNotMainnet(network: string): void {
  if (MAINNET_NAMES.has(network)) {
    throw new Error(
      "Mainnet is not supported until the security review (ROADMAP.md Phase E4) is done.",
    );
  }
}

/**
 * Validates an untrusted `deployments.json` value (for example one fetched
 * from the repository at runtime). Throws on anything malformed and on any
 * mainnet record.
 */
export function parseDeployments(value: unknown): DeploymentsDocument {
  if (typeof value === "string") value = JSON.parse(value);
  const doc = value as Partial<DeploymentsDocument> | null;
  if (!doc || doc.version !== 1 || !Array.isArray(doc.deployments)) {
    throw new TypeError("deployments.json must be { version: 1, deployments: [...] }.");
  }
  for (const record of doc.deployments) {
    if (!record || typeof record.network !== "string") {
      throw new TypeError("Every deployment record needs a network.");
    }
    assertNotMainnet(record.network);
    if (record.networkPassphrase === MAINNET_PASSPHRASE) {
      throw new Error("deployments.json must not contain mainnet records.");
    }
    if (typeof record.contractId !== "string" || !/^C[A-Z2-7]{55}$/.test(record.contractId)) {
      throw new TypeError(`Invalid contractId in deployment record: ${String(record.contractId)}`);
    }
    if (typeof record.wasmHash !== "string" || !/^[0-9a-f]{64}$/.test(record.wasmHash)) {
      throw new TypeError(`Invalid wasmHash for ${record.contractId}.`);
    }
    if (!Array.isArray(record.verification)) {
      throw new TypeError(`Missing verification results for ${record.contractId}.`);
    }
  }
  return doc as DeploymentsDocument;
}

function isVerified(record: DeploymentRecord): boolean {
  return record.verification.length > 0 && record.verification.every((v) => v.result === "Passed");
}

/**
 * Latest deployment for `network` whose scripted verification fully passed.
 * Defaults to the records bundled with this SDK version.
 */
export function latestDeployment(
  network = "testnet",
  deployments: DeploymentsDocument = KNOWN_DEPLOYMENTS,
): DeploymentRecord {
  assertNotMainnet(network);
  for (let i = deployments.deployments.length - 1; i >= 0; i -= 1) {
    const record = deployments.deployments[i];
    if (record.network === network && isVerified(record)) return record;
  }
  throw new UnknownDeploymentError(network);
}

/** Contract id of `latestDeployment(network)`. */
export function knownContractId(
  network = "testnet",
  deployments: DeploymentsDocument = KNOWN_DEPLOYMENTS,
): string {
  return latestDeployment(network, deployments).contractId;
}

/**
 * `contractId`, `rpcUrl` and `networkPassphrase` for the latest verified
 * deployment on `network`, ready to spread into `new EscrowClient({...})`.
 */
export function knownNetworkConfig(
  network = "testnet",
  deployments: DeploymentsDocument = KNOWN_DEPLOYMENTS,
): { contractId: string; rpcUrl: string; networkPassphrase: string } {
  const record = latestDeployment(network, deployments);
  return {
    contractId: record.contractId,
    rpcUrl: record.rpcUrl,
    networkPassphrase: record.networkPassphrase,
  };
}

export { KNOWN_DEPLOYMENTS };
