import { describe, expect, it } from "vitest";
import { MAINNET_NETWORK_PASSPHRASE, parseInputs } from "../src/inputs.js";

const base = { mode: "status", "contract-id": "CABC", "escrow-id": "42" };

describe("parseInputs", () => {
  it("parses status and defaults to testnet", () => {
    expect(parseInputs(base)).toMatchObject({ mode: "status", escrowId: 42n, rpcUrl: "https://soroban-testnet.stellar.org" });
  });

  it("requires create fields and parses integer values", () => {
    expect(parseInputs({ mode: "create", "contract-id": "CABC", "signer-secret": "SSECRET", payee: "GPayee", token: "CToken", amount: "1000", "condition-ref": "merge:1", "refund-after": "999" })).toMatchObject({ amount: 1000n, refundAfter: 999n });
  });

  it("rejects malformed or unsafe configuration", () => {
    expect(() => parseInputs({ ...base, "escrow-id": "-1" })).toThrow("non-negative");
    expect(() => parseInputs({ ...base, "network-passphrase": MAINNET_NETWORK_PASSPHRASE })).toThrow("Mainnet");
    expect(() => parseInputs({ mode: "release", "contract-id": "CABC", "escrow-id": "42" })).toThrow("signer-secret");
  });
});
