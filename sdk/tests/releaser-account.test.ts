/**
 * Offline unit tests for the releaser custom account client (issue #358).
 *
 * The management digest is verified byte-for-byte against the Rust
 * `ReleaserAccount::management_digest` using the shared vector captured in
 * `contracts/releaser-account/tests/management_digest.rs`. No network calls.
 */
import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  ManagementPayload,
  ReleaserAccountClient,
  buildSettleSignatures,
  signManagement,
  type ReleaserAccountAction,
  type SignerSignature,
} from "../src/index.js";

// Shared vector from contracts/releaser-account/tests/management_digest.rs
// (nonce 0, action SetThreshold(2), address CAAA...FCT4).
const CONTRACT_ADDRESS =
  "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4";
const EXPECTED_DIGEST_HEX =
  "81d15d2a6f9867d36fe1b8ca82c6fdcf40dca412a57f82b284a973d5dc6311eb";

const action: ReleaserAccountAction = { kind: "SetThreshold", threshold: 2 };
const nonce = 0n;

describe("ReleaserAccount management digest", () => {
  it("matches the Rust management_digest for the shared vector", () => {
    const digest = ManagementPayload.compute(CONTRACT_ADDRESS, action, nonce);
    expect(digest.toString("hex")).toBe(EXPECTED_DIGEST_HEX);
  });

  it("is exposed through ReleaserAccountClient.managementPayload", () => {
    const client = new ReleaserAccountClient({
      contractAddress: CONTRACT_ADDRESS,
    });
    const digest = client.managementPayload(action, nonce);
    expect(digest.toString("hex")).toBe(EXPECTED_DIGEST_HEX);
  });

  it("rejects a non-contract address", () => {
    const kp = Keypair.random();
    expect(() =>
      ManagementPayload.compute(kp.publicKey().toString(), action, nonce),
    ).toThrow(/Not a contract address/);
  });
});

describe("ReleaserAccount signing", () => {
  const keypairs = [Keypair.random(), Keypair.random(), Keypair.random()];
  const payload = ManagementPayload.compute(CONTRACT_ADDRESS, action, nonce);

  it("signManagement produces valid ed25519 signatures over the digest", () => {
    const sigs = signManagement(keypairs, payload);
    expect(sigs).toHaveLength(keypairs.length);
    for (let i = 0; i < keypairs.length; i++) {
      expect(
        keypairs[i].verify(payload, Buffer.from(sigs[i].signature, "hex")),
      ).toBe(true);
    }
  });

  it("buildSettleSignatures produces valid release/refund auth signatures", () => {
    const sigs = buildSettleSignatures(keypairs, payload);
    expect(sigs).toHaveLength(keypairs.length);
    for (let i = 0; i < keypairs.length; i++) {
      expect(
        keypairs[i].verify(payload, Buffer.from(sigs[i].signature, "hex")),
      ).toBe(true);
    }
  });

  it("distinct keypairs yield distinct signatures", () => {
    const sigs = signManagement(keypairs, payload);
    const signatures = sigs.map((s) => s.signature);
    expect(new Set(signatures).size).toBe(signatures.length);
  });
});
