import type { Signer, SignerOptions } from "./signer.js";

export interface RemoteSignerConfig {
  /** Account address represented by the remote signing service. */
  address: string;
  /** HTTPS endpoint accepting the request shapes documented below. */
  endpoint: string;
  /** Injectable fetch implementation for tests and custom runtimes. */
  fetch?: typeof fetch;
}

/**
 * Reference HTTP adapter for a remote signing service.
 *
 * Transaction requests POST `{ operation: "signTransaction", address,
 * xdr, networkPassphrase }` and expect `{ signedXdr }`. Auth-entry
 * requests use `operation: "signAuthEntry"` and expect `{ signedAuthEntry }`.
 * The endpoint receives unsigned public transaction data, never a secret key.
 */
export class RemoteSigner implements Signer {
  private readonly endpoint: URL;
  private readonly fetcher: typeof fetch;

  constructor(config: RemoteSignerConfig) {
    this.endpoint = new URL(config.endpoint);
    const localDevelopmentHost = ["localhost", "127.0.0.1", "[::1]"].includes(this.endpoint.hostname);
    if (this.endpoint.protocol !== "https:" && !(this.endpoint.protocol === "http:" && localDevelopmentHost)) {
      throw new Error("Remote signer endpoints must use HTTPS (HTTP is allowed only on localhost).");
    }
    this.fetcher = config.fetch ?? fetch;
    this.address = config.address;
  }

  readonly address: string;

  publicKey(): string {
    return this.address;
  }

  async signTransaction(xdr: string, options: SignerOptions): Promise<string> {
    const response = await this.request({
      operation: "signTransaction",
      xdr,
      networkPassphrase: options.networkPassphrase,
    });
    return this.requiredString(response.signedXdr);
  }

  async signAuthEntry(xdr: string, options: SignerOptions): Promise<string> {
    const response = await this.request({
      operation: "signAuthEntry",
      xdr,
      networkPassphrase: options.networkPassphrase,
    });
    return this.requiredString(response.signedAuthEntry);
  }

  private async request(payload: Record<string, string>): Promise<Record<string, unknown>> {
    try {
      const response = await this.fetcher(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: this.address, ...payload }),
      });
      if (!response.ok) throw new Error("remote signer rejected request");
      const body: unknown = await response.json();
      if (!body || typeof body !== "object") throw new Error("invalid response");
      return body as Record<string, unknown>;
    } catch {
      // Keep response bodies and network errors out of SDK error messages.
      throw new Error("The remote signer request failed.");
    }
  }

  private requiredString(value: unknown): string {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error("The remote signer returned an invalid signature.");
    }
    return value;
  }
}
