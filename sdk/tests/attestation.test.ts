// Attestation-based release (issue #42). The SDK helpers are pure and
// offline, so these tests need no contract and no network.

import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import {
  ATTESTATION_ACTION_RELEASE,
  ATTESTATION_DOMAIN,
  buildReleaseAttestationMessage,
  signReleaseAttestation,
  verifyReleaseAttestation,
} from "../src/attestation.js";

// A different contract id, same length, only used as a message input.
const OTHER_CONTRACT_ID =
  "CB7WHNBNHEVPFTGDOWHFMDOWKLTA2Z4CBR3KZGYIVSSJNUT3OGWYSW2X";
const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
// A contract id from the contract tests, chosen as a fixed fixture.
const CONTRACT_ID =
  "CB7WHNBNHEVPFTGDOWHFMDOWKLTA2Z4CBR3KZGYIVSSJNUT3OGWYSW2H";

function params(overrides: Partial<Parameters<typeof buildReleaseAttestationMessage>[0]> = {}) {
  return {
    contractId: CONTRACT_ID,
    networkPassphrase: NETWORK_PASSPHRASE,
    escrowId: 42n,
    ...overrides,
  };
}

describe("buildReleaseAttestationMessage", () => {
  it("builds the exact message the contract verifies", () => {
    // Fixed vector, computed by hand from the layout in
    // contracts/escrow/src/attestation.rs: domain || contract id (strkey)
    // || network id (SHA-256 of the passphrase) || escrow id (u64 BE) ||
    // "release". If this breaks, the SDK and the contract have drifted.
    const expected =
      "646f63666f72756d2d657363726f773a72656c656173652d6174746573746174696f6e3a7631" +
      "43423757484e424e48455650465447444f5748464d444f574b4c5441325a34434252334b5a4759495653534a4e5554334f47575953573248" +
      "cee0302d59844d32bdca915c8203dd44b33fbb7edc19051ea37abedf28ecd472" +
      "000000000000002a" +
      "72656c65617365";
    expect(buildReleaseAttestationMessage(params()).toString("hex")).toBe(
      expected,
    );
    expect(buildReleaseAttestationMessage(params()).length).toBe(141);
  });

  it("binds the message to the contract and the network", () => {
    const base = buildReleaseAttestationMessage(params());
    expect(
      buildReleaseAttestationMessage(
        params({ contractId: OTHER_CONTRACT_ID }),
      ),
    ).not.toEqual(base);
    expect(
      buildReleaseAttestationMessage(
        params({ networkPassphrase: "Public Global Stellar Network ; September 2015" }),
      ),
    ).not.toEqual(base);
    expect(buildReleaseAttestationMessage(params({ escrowId: 43n }))).not.toEqual(base);
  });

  it("rejects a negative escrow id", () => {
    expect(() => buildReleaseAttestationMessage(params({ escrowId: -1n }))).toThrow(
      RangeError,
    );
  });

  it("exposes the domain and action the contract expects", () => {
    expect(ATTESTATION_DOMAIN).toBe("docforum-escrow:release-attestation:v1");
    expect(ATTESTATION_ACTION_RELEASE).toBe("release");
  });
});

describe("signReleaseAttestation / verifyReleaseAttestation", () => {
  it("signs and verifies a round trip", () => {
    const attester = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7));
    const signed = signReleaseAttestation({ ...params(), attester });
    expect(signed.attester).toBe(attester.publicKey());
    expect(signed.signature.length).toBe(64);
    expect(
      verifyReleaseAttestation({
        attester: signed.attester,
        message: signed.message,
        signature: signed.signature,
      }),
    ).toBe(true);
  });

  it("fails verification for a tampered message or a wrong attester", () => {
    const attester = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7));
    const other = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 9));
    const signed = signReleaseAttestation({ ...params(), attester });
    const tampered = Buffer.from(signed.message);
    tampered[tampered.length - 1] ^= 1;
    expect(
      verifyReleaseAttestation({
        attester: signed.attester,
        message: tampered,
        signature: signed.signature,
      }),
    ).toBe(false);
    expect(
      verifyReleaseAttestation({
        attester: other.publicKey(),
        message: signed.message,
        signature: signed.signature,
      }),
    ).toBe(false);
  });
});
