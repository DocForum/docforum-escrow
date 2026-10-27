/** One escrow record as returned by the indexer (all numeric fields are strings, as GraphQL serializes them). */
export interface IndexedEscrow {
  id: string;
  escrowId: string;
  payer: string;
  payee: string;
  token: string;
  amount: string;
  conditionRef: string;
  releasers: string[];
  threshold: string;
  refundAfter: string | null;
  notifyPayee: boolean;
  requiresAcceptance: boolean;
  acceptedAt: string | null;
  status: "Funded" | "Released" | "Refunded";
  updatedLedger: string;
}

/** One page of {@link IndexedEscrow} records plus the cursor to fetch the next page. */
export interface EscrowPage {
  nodes: IndexedEscrow[];
  endCursor: string | null;
  hasNextPage: boolean;
}

/** Configuration for an {@link EscrowIndexerClient}. */
export interface EscrowIndexerClientConfig {
  /** URL for an indexer deployed by the application operator. */
  endpoint: string;
  /** Injectable fetch implementation for tests and custom runtimes. */
  fetch?: typeof fetch;
}

const QUERY = `query ListEscrows($first: Int!, $after: Cursor) {
  escrows(first: $first, after: $after) {
    nodes { id escrowId payer payee token amount conditionRef releasers threshold refundAfter notifyPayee requiresAcceptance acceptedAt status updatedLedger }
    pageInfo { endCursor hasNextPage }
  }
}`;

/** Typed read-only client for a consumer-operated SubQuery endpoint. */
export class EscrowIndexerClient {
  private readonly endpoint: URL;
  private readonly fetcher: typeof fetch;

  constructor(config: EscrowIndexerClientConfig) {
    this.endpoint = new URL(config.endpoint);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(this.endpoint.hostname);
    if (this.endpoint.protocol !== "https:" && !(this.endpoint.protocol === "http:" && local)) {
      throw new Error("Indexer endpoints must use HTTPS (HTTP is allowed only on localhost).");
    }
    this.fetcher = config.fetch ?? fetch;
  }

  /** Fetches one page of indexed escrows (`first` between 1 and 100, default 50; `after` is a cursor from a prior page). */
  async listEscrows(options: { first?: number; after?: string | null } = {}): Promise<EscrowPage> {
    const first = options.first ?? 50;
    if (!Number.isInteger(first) || first < 1 || first > 100) {
      throw new RangeError("first must be an integer between 1 and 100");
    }

    let response: Response;
    try {
      response = await this.fetcher(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: QUERY, variables: { first, after: options.after ?? null } }),
      });
      if (!response.ok) throw new Error("request failed");
      const payload: unknown = await response.json();
      return parseEscrowPage(payload);
    } catch {
      throw new Error("The escrow indexer query failed.");
    }
  }
}

function parseEscrowPage(payload: unknown): EscrowPage {
  if (!payload || typeof payload !== "object") throw new Error("invalid indexer response");
  const data = (payload as { data?: { escrows?: unknown }; errors?: unknown }).data?.escrows;
  if (!data || typeof data !== "object") throw new Error("missing escrow page");
  const page = data as { nodes?: unknown; pageInfo?: { endCursor?: unknown; hasNextPage?: unknown } };
  if (!Array.isArray(page.nodes) || typeof page.pageInfo?.hasNextPage !== "boolean") {
    throw new Error("invalid escrow page");
  }
  return {
    nodes: page.nodes as IndexedEscrow[],
    endCursor: typeof page.pageInfo.endCursor === "string" ? page.pageInfo.endCursor : null,
    hasNextPage: page.pageInfo.hasNextPage,
  };
}
