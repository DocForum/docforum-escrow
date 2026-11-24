// Offline SDK test for `getAllowedTokens()` (issue #299). No network: the
// generated contract client is mocked, so this verifies the mapping from
// the generated binding's simulated result to the public API (`string[]`),
// including the "empty list means any token" case, and that the call is a
// read-only simulation (never signed or submitted).
import { describe, expect, it, vi } from "vitest";

const { get_allowed_tokens, constructorOptions } = vi.hoisted(() => ({
  get_allowed_tokens: vi.fn(),
  constructorOptions: [] as unknown[],
}));

vi.mock("../src/generated/contract-client.js", () => ({
  Client: class {
    constructor(options: unknown) {
      constructorOptions.push(options);
    }
    // Assigned rather than declared on the prototype so each instance
    // sees the current mock implementation.
    get_allowed_tokens = get_allowed_tokens;
  },
}));

import { EscrowClient } from "../src/index.js";

describe("EscrowClient.getAllowedTokens (offline, mocked simulation)", () => {
  it("returns the configured allowlist as plain addresses", async () => {
    const configured = [
      "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
      "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    ];
    get_allowed_tokens.mockResolvedValue({ result: configured });

    const client = new EscrowClient({ contractId: "CCONTRACT" });
    await expect(client.getAllowedTokens()).resolves.toEqual(configured);
  });

  it("returns an empty array for an instance deployed without an allowlist", async () => {
    // Empty = any token is accepted. This is the constructor case that
    // preserves the pre-allowlist behavior.
    get_allowed_tokens.mockResolvedValue({ result: [] });

    const client = new EscrowClient({ contractId: "CCONTRACT" });
    await expect(client.getAllowedTokens()).resolves.toEqual([]);
  });

  it("is read-only: one simulation, no signing or submission", async () => {
    get_allowed_tokens.mockClear();
    constructorOptions.length = 0;
    get_allowed_tokens.mockResolvedValue({ result: [] });

    const client = new EscrowClient({
      contractId: "CCONTRACT",
      rpcUrl: "http://localhost:8000/soroban/rpc",
      allowHttp: true,
    });
    await client.getAllowedTokens();

    expect(get_allowed_tokens).toHaveBeenCalledTimes(1);
    // No args, no options: the getter takes no caller, no signer.
    expect(get_allowed_tokens).toHaveBeenCalledWith();

    // The generated client is built with no signing keypair — there is
    // nothing to sign, and no `signAndSend` in this path.
    const options = constructorOptions[0] as Record<string, unknown>;
    expect(options).toMatchObject({
      contractId: "CCONTRACT",
      rpcUrl: "http://localhost:8000/soroban/rpc",
    });
    expect(options.publicKey).toBeUndefined();
    expect(options.signTransaction).toBeUndefined();
  });
});
