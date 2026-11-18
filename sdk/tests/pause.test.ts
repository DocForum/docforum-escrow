/**
 * Offline checks for the operator surface added by issue #35 (ADR 0011).
 * The contract tests cover the behaviour; here we only pin that the SDK
 * exposes the four wrappers and that they are callable without network
 * access being attempted before signer resolution fails.
 */
import { describe, expect, it } from "vitest";
import { EscrowClient } from "../src/index.js";
import { Keypair } from "@stellar/stellar-sdk";

describe("emergency-pause operator surface", () => {
  const client = new EscrowClient({ contractId: Keypair.random().publicKey() });

  it("exposes pause/unpause/isPaused/getPauseAdmin", () => {
    expect(typeof client.pause).toBe("function");
    expect(typeof client.unpause).toBe("function");
    expect(typeof client.isPaused).toBe("function");
    expect(typeof client.getPauseAdmin).toBe("function");
  });

  it("takes a signer for the mutating calls", async () => {
    // Both reject a malformed signer before any transaction is built.
    await expect(client.pause({} as never)).rejects.toBeTruthy();
    await expect(client.unpause({} as never)).rejects.toBeTruthy();
  });
});
