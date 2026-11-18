import { describe, expect, it, vi } from "vitest";
import { EscrowIndexerClient } from "../src/indexer-client.js";

describe("EscrowIndexerClient", () => {
  it("queries a caller-configured endpoint with cursor pagination", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: {
        escrows: {
          nodes: [{ id: "7", escrowId: "7", status: "Funded" }],
          pageInfo: { endCursor: "cursor-1", hasNextPage: true },
        },
      },
    }), { status: 200 }));
    const client = new EscrowIndexerClient({ endpoint: "https://indexer.example.test/graphql", fetch: fetchMock as unknown as typeof fetch });

    await expect(client.listEscrows({ first: 1, after: "cursor-0" })).resolves.toMatchObject({
      nodes: [{ escrowId: "7", status: "Funded" }],
      endCursor: "cursor-1",
      hasNextPage: true,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://indexer.example.test/graphql"),
      expect.objectContaining({ body: expect.stringContaining('"after":"cursor-0"') }),
    );
  });

  it("rejects insecure endpoints and invalid page sizes", async () => {
    expect(() => new EscrowIndexerClient({ endpoint: "http://indexer.example.test" })).toThrow("must use HTTPS");
    const client = new EscrowIndexerClient({ endpoint: "http://localhost:3000/graphql" });
    await expect(client.listEscrows({ first: 101 })).rejects.toThrow("between 1 and 100");
  });
});
