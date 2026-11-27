/**
 * Network settings for the SubQuery project (issue #348).
 *
 * Testnet is the default: hard rule 4 keeps mainnet out of every default until
 * the security review is done. The public passphrase needs an explicit, exact
 * opt-in, mirroring the TypeScript SDK's `allowMainnet` guard.
 */

export interface IndexerNetworkConfig {
  /** Stellar network passphrase, used as the SubQuery `chainId`. */
  chainId: string;
  /** Archive-capable Horizon endpoint. */
  horizonUrl: string;
  /** Soroban RPC endpoint. */
  rpcUrl: string;
}

export const TESTNET_NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
export const MAINNET_NETWORK_PASSPHRASE = "Public Global Stellar Network ; September 2015";

const DEFAULT_HORIZON_URL = "https://horizon-testnet.stellar.org";
const DEFAULT_RPC_URL = "https://soroban-testnet.stellar.org";

/**
 * Hostnames that can only serve the public network. Checking the endpoints as
 * well as the passphrase means a typo in the passphrase variable cannot point
 * the indexer at mainnet: the guard refuses the mainnet RPC/Horizon host
 * whether or not the passphrase matched.
 */
function isMainnetEndpoint(value: string): boolean {
  let host = "";
  // Tolerate a missing scheme (`horizon.stellar.org`), since that typo must
  // not slip past the guard either.
  for (const candidate of [value, `http://${value}`]) {
    try {
      const parsed = new URL(candidate);
      if (parsed.hostname) {
        host = parsed.hostname.toLowerCase();
        break;
      }
    } catch {
      // try the next candidate
    }
  }
  if (!host) return false;
  if (host === "horizon.stellar.org" || host === "soroban.stellar.org") return true;
  const labels = host.split(".");
  return labels.includes("mainnet") || labels.includes("pubnet");
}

/**
 * Resolve the indexer network from the environment.
 *
 * `DOCFORUM_NETWORK_PASSPHRASE` defaults to testnet; the existing
 * `DOCFORUM_HORIZON_URL` and `DOCFORUM_RPC_URL` overrides are unchanged.
 * Surrounding whitespace is trimmed, so a padded passphrase cannot slip past
 * the public-network check. The public passphrase or a public-network endpoint
 * is refused unless `DOCFORUM_ALLOW_MAINNET` is exactly `true` — not `1`,
 * `yes`, `TRUE` or a misspelled variable name. A missing or empty passphrase
 * falls back to testnet rather than silently selecting a different network.
 */
export function resolveNetworkConfig(env: NodeJS.ProcessEnv = process.env): IndexerNetworkConfig {
  const chainId = env.DOCFORUM_NETWORK_PASSPHRASE?.trim() || TESTNET_NETWORK_PASSPHRASE;
  const horizonUrl = env.DOCFORUM_HORIZON_URL?.trim() || DEFAULT_HORIZON_URL;
  const rpcUrl = env.DOCFORUM_RPC_URL?.trim() || DEFAULT_RPC_URL;

  const publicNetwork =
    chainId === MAINNET_NETWORK_PASSPHRASE || isMainnetEndpoint(horizonUrl) || isMainnetEndpoint(rpcUrl);

  if (publicNetwork && env.DOCFORUM_ALLOW_MAINNET !== "true") {
    throw new Error(
      "Refusing to index the Stellar public network. Hard rule 4 keeps mainnet out of " +
        "defaults until the security review; remove the public passphrase/endpoints, or set " +
        "DOCFORUM_ALLOW_MAINNET=true (exactly) to opt in deliberately.",
    );
  }

  return { chainId, horizonUrl, rpcUrl };
}
