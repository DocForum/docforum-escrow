import { Server as RpcServer } from "@stellar/stellar-sdk/rpc";

/** A configured Soroban RPC endpoint. Lower priorities are preferred. */
export interface RpcProviderConfig {
  url: string;
  priority?: number;
  /** Maximum number of ledgers this endpoint may trail the freshest endpoint. */
  maxLedgerLag?: number;
  /** Health-check timeout in milliseconds. Defaults to 5 seconds. */
  timeoutMs?: number;
}

export interface RpcProviderHealth {
  url: string;
  priority: number;
  latestLedger: number;
  healthy: boolean;
  error?: unknown;
}

export type RpcProviderFactory = (config: RpcProviderConfig, allowHttp: boolean) => RpcServer;

interface Provider {
  config: Required<Pick<RpcProviderConfig, "url" | "priority" | "maxLedgerLag" | "timeoutMs">>;
  rpc: RpcServer;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`RPC health check timed out for ${url}.`)), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

/**
 * Selects usable Soroban RPC endpoints without submitting a write during a
 * health check. Writes must check a submitted hash before resubmission.
 */
export class RpcProviderPool {
  private readonly providers: readonly Provider[];
  private readonly networkPassphrase?: string;

  constructor(
    configs: readonly RpcProviderConfig[],
    options: { networkPassphrase?: string; allowHttp?: boolean; rpcFactory?: RpcProviderFactory } = {},
  ) {
    if (configs.length === 0) throw new RangeError("At least one RPC provider is required.");
    this.networkPassphrase = options.networkPassphrase;
    this.providers = configs
      .map((config) => ({
        config: {
          url: config.url,
          priority: config.priority ?? 0,
          maxLedgerLag: config.maxLedgerLag ?? 5,
          timeoutMs: config.timeoutMs ?? 5_000,
        },
        rpc: options.rpcFactory?.(config, options.allowHttp ?? false) ?? new RpcServer(config.url, { allowHttp: options.allowHttp ?? false }),
      }))
      .sort((a, b) => a.config.priority - b.config.priority);
  }

  get urls(): readonly string[] { return this.providers.map(({ config }) => config.url); }

  /** Probe all endpoints and return healthy endpoints in priority order. */
  async healthyProviders(): Promise<readonly { url: string; rpc: RpcServer }[]> {
    const health = await Promise.all(this.providers.map(async (provider): Promise<RpcProviderHealth> => {
      try {
        const ledger = await withTimeout(provider.rpc.getLatestLedger(), provider.config.timeoutMs, provider.config.url);
        const getNetwork = (provider.rpc as Partial<Pick<RpcServer, "getNetwork">>).getNetwork;
        if (this.networkPassphrase && typeof getNetwork === "function") {
          const network = await withTimeout(getNetwork.call(provider.rpc), provider.config.timeoutMs, provider.config.url);
          if (network.passphrase !== this.networkPassphrase) {
            throw new Error(`RPC provider ${provider.config.url} reports a different network passphrase.`);
          }
        }
        return { url: provider.config.url, priority: provider.config.priority, latestLedger: ledger.sequence, healthy: true };
      } catch (error) {
        return { url: provider.config.url, priority: provider.config.priority, latestLedger: -1, healthy: false, error };
      }
    }));
    if (health.some((item) => item.error instanceof Error && /different network passphrase/.test(item.error.message))) {
      throw new Error("RPC providers report different network passphrases; refusing to fail over across networks.");
    }
    const freshest = Math.max(...health.map((item) => item.latestLedger));
    const usable = health.filter((item) => {
      const provider = this.providers.find((candidate) => candidate.config.url === item.url)!;
      return item.healthy && item.latestLedger >= freshest - provider.config.maxLedgerLag;
    });
    if (usable.length === 0) {
      const details = health.map((item) => `${item.url}: ${item.error instanceof Error ? item.error.message : "unhealthy"}`).join("; ");
      throw new Error(`No healthy RPC provider is available. ${details}`);
    }
    const usableUrls = new Set(usable.map((item) => item.url));
    return this.providers
      .filter((provider) => usableUrls.has(provider.config.url))
      .map((provider) => ({ url: provider.config.url, rpc: provider.rpc }));
  }

  async select(): Promise<{ url: string; rpc: RpcServer }> {
    return (await this.healthyProviders())[0]!;
  }

  /** Run an idempotent read against the preferred endpoint, then fail over. */
  async withReadFailover<T>(operation: (rpc: RpcServer) => Promise<T>): Promise<T> {
    const providers = await this.healthyProviders();
    let lastError: unknown;
    for (const provider of providers) {
      try { return await operation(provider.rpc); }
      catch (error) { lastError = error; }
    }
    throw lastError ?? new Error("All RPC providers failed the read.");
  }
}
