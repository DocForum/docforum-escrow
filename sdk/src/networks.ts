import { Networks } from "@stellar/stellar-sdk";
import { TESTNET_NETWORK_PASSPHRASE, TESTNET_RPC_URL } from "./internal.js";

/**
 * Named network presets (Phase E6). Each preset bundles the RPC URL, the
 * network passphrase and the known contract ids for that network. Hard rule
 * 4: testnet only until the security review — mainnet is deliberately not a
 * preset, and constructing a client against the mainnet passphrase throws
 * unless the caller passes `allowMainnet: true`.
 */
export interface NetworkPreset {
  /** Human-readable network name. */
  name: string;
  /** Soroban RPC endpoint for this network. */
  rpcUrl: string;
  /** Stellar network passphrase. */
  networkPassphrase: string;
  /** Known docforum-escrow contract ids deployed on this network. */
  contractIds: Record<string, string>;
  /** Plain-HTTP RPC is allowed (local quickstart only). Defaults to `false`. */
  allowHttp?: boolean;
}

/** The Stellar mainnet passphrase — never a default, only an explicit opt-in. */
export const MAINNET_NETWORK_PASSPHRASE = Networks.PUBLIC;

/** Built-in network presets (RPC URL, passphrase and known contract ids) keyed by name. */
export const networks = {
  /** Soroban testnet — the only network wired into defaults (hard rule 4). */
  testnet: {
    name: "testnet",
    rpcUrl: TESTNET_RPC_URL,
    networkPassphrase: TESTNET_NETWORK_PASSPHRASE,
    // Current upstream deployment (docs/testnet-deployments.md) and the
    // testnet native XLM Stellar Asset Contract on its token allowlist.
    contractIds: {
      escrow: "CB7WHNBNHEVPFTGDOWHFMDOWKLTA2Z4CBR3KZGYIVSSJNUT3OGWYSW2H",
      nativeXlm: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    },
  } as NetworkPreset,
  /** Stellar futurenet — an experimental testnet, still not mainnet. */
  futurenet: {
    name: "futurenet",
    rpcUrl: "https://rpc-futurenet.stellar.org",
    networkPassphrase: Networks.FUTURENET,
    contractIds: {},
  } as NetworkPreset,
  /** A local quickstart node (private network). */
  local: {
    name: "local",
    rpcUrl: "http://localhost:8000/soroban/rpc",
    networkPassphrase: "Standalone Network ; February 2017",
    contractIds: {},
    allowHttp: true,
  } as NetworkPreset,
} as const;

/** Thrown when a client is configured for mainnet without the explicit opt-in. */
export class MainnetNotAllowedError extends Error {
  readonly name = "MainnetNotAllowedError";
  constructor() {
    super(
      "Refusing to construct a client against the Stellar mainnet passphrase. " +
        "Hard rule 4 keeps mainnet out of defaults until the security review; " +
        "pass allowMainnet: true to opt in deliberately.",
    );
  }
}
