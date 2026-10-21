// Network configuration for the live integration suite
// (tests/integration.test.ts).
//
// The same tests run against either network:
//   npm run test:integration        → live testnet (the default, unchanged)
//   npm run test:integration:local  → a local Stellar quickstart container
//
// `ESCROW_TEST_NETWORK=local` flips the defaults; individual values can be
// overridden when a network was started elsewhere (e.g. quickstart on a
// different port). See README.md, "Running the integration suite locally".
//
// No secrets here — contract ids, RPC URLs and passphrases are public. Every
// run generates fresh keypairs and funds them through Friendbot; never commit
// a secret key, even a local/testnet one.
import { Asset, Keypair } from "@stellar/stellar-sdk";

export type IntegrationNetworkName = "local" | "testnet";

export interface IntegrationNetwork {
  name: IntegrationNetworkName;
  /** Human-readable label used in the test suite's describe block. */
  label: string;
  rpcUrl: string;
  networkPassphrase: string;
  friendbotUrl: string;
  /** True when the RPC is plain HTTP (a local quickstart), which the SDK requires opting into. */
  allowHttp: boolean;
  /** The deployed escrow contract this suite exercises. */
  contractId: string;
  /** Native XLM Stellar Asset Contract, derived from the passphrase. */
  nativeTokenId: string;
  /** Local runs deploy the WASM from this checkout, so quorum entry points exist. */
  quorumSupported: boolean;
}

/**
 * The deployment recorded in docs/testnet-deployments.md (Phase E4).
 *
 * It predates later contract changes (`notify_payee`, acceptance, quorum,
 * `top_up`), so a full-suite testnet run needs a deployment built from this
 * checkout — pass its id as `ESCROW_TESTNET_CONTRACT_ID`. CI runs the suite
 * against a local quickstart network instead, precisely so a stale documented
 * deployment cannot hide SDK regressions.
 */
const TESTNET_CONTRACT_ID = "CAHQ4J3T23WSIBBG6SI6EAYR5Q2HIPKG5YMC4SMZBOTYA6MYK2VADEV5";
const TESTNET_RPC_URL = "https://soroban-testnet.stellar.org";
const TESTNET_FRIENDBOT_URL = "https://friendbot.stellar.org";
const TESTNET_NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

/** Defaults exposed by `stellar/quickstart --local`. */
const LOCAL_RPC_URL = "http://localhost:8000/soroban/rpc";
const LOCAL_FRIENDBOT_URL = "http://localhost:8000/friendbot";
const LOCAL_NETWORK_PASSPHRASE = "Standalone Network ; February 2017";

/** `new URL` keeps this honest for custom endpoints; malformed URLs surface as a clear error. */
function isPlainHttp(rpcUrl: string): boolean {
  return new URL(rpcUrl).protocol === "http:";
}

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function resolveNetworkName(): IntegrationNetworkName {
  const requested = env("ESCROW_TEST_NETWORK") ?? "testnet";
  if (requested !== "local" && requested !== "testnet") {
    throw new Error(
      `Unknown ESCROW_TEST_NETWORK "${requested}" — expected "local" or "testnet".`,
    );
  }
  return requested;
}

function localConfig(): IntegrationNetwork {
  // The contract id cannot be defaulted: every local network deploy has a new
  // one. Failing loudly here beats running the suite against the testnet
  // deployment by accident.
  const contractId = env("ESCROW_LOCAL_CONTRACT_ID");
  if (!contractId) {
    throw new Error(
      "ESCROW_LOCAL_CONTRACT_ID is required when ESCROW_TEST_NETWORK=local. " +
        "Deploy the WASM to the local network first — see README.md, " +
        '"Running the integration suite locally".',
    );
  }
  const networkPassphrase = env("ESCROW_LOCAL_NETWORK_PASSPHRASE") ?? LOCAL_NETWORK_PASSPHRASE;
  const rpcUrl = env("ESCROW_LOCAL_RPC_URL") ?? LOCAL_RPC_URL;
  return {
    name: "local",
    label: "a local quickstart network",
    rpcUrl,
    networkPassphrase,
    friendbotUrl: env("ESCROW_LOCAL_FRIENDBOT_URL") ?? LOCAL_FRIENDBOT_URL,
    allowHttp: isPlainHttp(rpcUrl),
    contractId,
    nativeTokenId: Asset.native().contractId(networkPassphrase),
    // A local run deploys freshly built WASM, so the quorum entry points
    // (#119) are always present. The documented testnet deployment predates
    // them, hence the opt-in flag below.
    quorumSupported: true,
  };
}

function testnetConfig(): IntegrationNetwork {
  const networkPassphrase = env("ESCROW_TESTNET_NETWORK_PASSPHRASE") ?? TESTNET_NETWORK_PASSPHRASE;
  const rpcUrl = env("ESCROW_TESTNET_RPC_URL") ?? TESTNET_RPC_URL;
  return {
    name: "testnet",
    label: "live testnet",
    rpcUrl,
    networkPassphrase,
    friendbotUrl: env("ESCROW_TESTNET_FRIENDBOT_URL") ?? TESTNET_FRIENDBOT_URL,
    allowHttp: isPlainHttp(rpcUrl),
    contractId: env("ESCROW_TESTNET_CONTRACT_ID") ?? TESTNET_CONTRACT_ID,
    nativeTokenId: Asset.native().contractId(networkPassphrase),
    // Enable once a quorum-capable deployment is recorded in
    // docs/testnet-deployments.md.
    quorumSupported: env("TESTNET_QUORUM_SUPPORTED") === "true",
  };
}

export const network: IntegrationNetwork =
  resolveNetworkName() === "local" ? localConfig() : testnetConfig();

/**
 * The configured network's current ledger close time, in unix seconds.
 * `refundAfter` is compared against the ledger timestamp, so deadline-based
 * tests derive their values from this rather than the runner's wall clock.
 */
export async function networkNow(): Promise<number> {
  const res = await fetch(network.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestLedger" }),
  });
  if (!res.ok) {
    throw new Error(`getLatestLedger failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as {
    result?: { closeTime?: string; latestLedgerCloseTime?: string };
    error?: { message?: string };
  };
  const closeTime = body.result?.closeTime ?? body.result?.latestLedgerCloseTime;
  if (closeTime === undefined) {
    throw new Error(`getLatestLedger returned no close time: ${JSON.stringify(body)}`);
  }
  return Number(closeTime);
}

/**
 * Generate a fresh account and fund it through the configured network's
 * Friendbot. Friendbot is rate-limited independently of the test assertions,
 * so only transient funding/network failures are retried; transaction and
 * assertion failures never are.
 */
export async function fundedKeypair(): Promise<Keypair> {
  const kp = Keypair.random();
  const url = `${network.friendbotUrl}?addr=${encodeURIComponent(kp.publicKey())}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url);
      if (res.ok) return kp;
      const detail = await res.text();
      if (res.status < 500 && res.status !== 429) {
        throw new Error(`Friendbot funding failed: ${res.status} ${detail}`);
      }
      if (attempt === 4) throw new Error(`Friendbot funding failed after retries: ${res.status} ${detail}`);
    } catch (error) {
      if (attempt === 4 || (error instanceof Error && error.message.startsWith("Friendbot funding failed:"))) {
        throw new Error(`Friendbot funding failed for ${kp.publicKey()}: ${String(error)}`);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000 * 2 ** attempt));
  }
  throw new Error("Friendbot funding failed after retries");
}
