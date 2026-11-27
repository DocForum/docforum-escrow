import { Keypair } from "@stellar/stellar-sdk";
import { type InstrumentationOptions } from "./instrumentation.js";
import { type ArchivedEntryBehavior } from "./archived-entries.js";
import { type NetworkPreset } from "./networks.js";
import { type DEFAULT_LIFECYCLE_OPTIONS, type TransactionLifecycleOptions } from "./lifecycle.js";
import { type RpcProviderConfig } from "./rpc-providers.js";

/** Connection settings for an {@link EscrowClient}: which contract, and (optionally) which network. */
export interface EscrowClientConfig {
  /** The deployed docforum-escrow contract's address (`C…`). */
  contractId: string;
  /** Default: Soroban testnet RPC. */
  rpcUrl?: string;
  /** Prioritized Soroban RPC endpoints. `rpcUrl` remains the single-endpoint shorthand. */
  rpcProviders?: readonly RpcProviderConfig[];
  /** Default: Stellar testnet passphrase. */
  networkPassphrase?: string;
  /**
   * Optional OpenTelemetry / event-hook instrumentation (issue #129). With no
   * tracer and no `onEvent` callback, calls take the uninstrumented path.
   */
  instrumentation?: InstrumentationOptions;
  /** Shorthand for `instrumentation.onEvent`. */
  onEvent?: InstrumentationOptions["onEvent"];
  /** Use the restore signer to authorize calls that automatically restore archived entries. */
  archivalBehavior?: ArchivedEntryBehavior;
  restoreSigner?: Keypair;
  /**
   * Named network preset (Phase E6). Supplies `rpcUrl` and `networkPassphrase`
   * defaults; explicit `rpcUrl`/`networkPassphrase` still win. Custom networks
   * (e.g. a private quickstart) can be configured without a preset.
   */
  network?: NetworkPreset;
  /**
   * Explicit opt-in required to construct a client against the Stellar
   * mainnet passphrase (hard rule 4). Defaults to `false`.
   */
  allowMainnet?: boolean;
  /**
   * Allow a plain-HTTP `rpcUrl` (e.g. a private quickstart node). Defaults to
   * the preset's `allowHttp` (only `networks.local` sets it), else `false`.
   */
  allowHttp?: boolean;
  /**
   * Verify the RPC's reported network passphrase against the configured one,
   * lazily and once, before the client's first network call, and throw
   * `NetworkMismatchError` on a mismatch. Never runs during construction.
   *
   * - `true`: always verify. An RPC that cannot report its network (no
   *   `getNetwork`) is an error, since verification was explicitly asked for.
   *   Recommended with a custom `rpcUrl`, so it cannot silently point the
   *   client at a different network (including mainnet) than its passphrase.
   * - `false`: never verify automatically (`verifyNetwork()` still works on
   *   demand).
   * - unset (default): verify only when a `network` preset is selected, and
   *   skip the check if the RPC has no `getNetwork` (e.g. an offline test
   *   double).
   *
   * The result is cached: one `getNetwork` round trip per client, not per
   * call. A failed check is not cached, so a transient RPC error is retryable.
   */
  verifyNetwork?: boolean;
  /**
   * Controls the contract-version check before the first network call:
   *
   * - `true`: check on first use. An unsupported version, an older deployment
   *   with no `version()`, or a failed lookup rejects the call.
   * - `false`: never check automatically (`verifyContractVersion()` still works
   *   on demand).
   * - unset (default): check only when a `network` preset is selected. Only a
   *   version known to be unsupported rejects the call. An older deployment or
   *   a failed lookup doesn't, so existing read paths keep working.
   *
   * A successful check is cached for the client. A failed lookup is not, so a
   * transient RPC error is retryable.
   */
  verifyContractVersion?: boolean;
  /**
   * Transaction lifecycle tuning (Phase E6, issue #62): timeouts for
   * simulate, send and confirm, plus the `TRY_AGAIN_LATER` backoff budget.
   * Defaults ({@link DEFAULT_LIFECYCLE_OPTIONS}) apply per field, so partial
   * overrides are fine. Used by `submitSigned` and the `prepare*` methods;
   * retry semantics are documented in `sdk/README.md` ("Transaction lifecycle").
   */
  transaction?: TransactionLifecycleOptions;
}
