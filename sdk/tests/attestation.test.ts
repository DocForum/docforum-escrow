/**
 * Offline unit tests for attestation signing (Phase E5, issue #75).
 *
 * The message layout is the contract between the SDK and
 * `build_attestation_message` in contracts/escrow/src/lib.rs, so these pin
 * every field — domain, network id, contract id, escrow id and action — and
 * verify the produced signature with the signer's own key. No RPC is used.
 */
import { describe, expect, it } from "vitest";
import { Keypair, Networks, hash } from "@stellar/stellar-sdk";
import {
  ATTESTATION_DOMAIN,
  EscrowClient,
  buildAttestationMessage,
  signAttestation,
} from "../src/index.js";

const CONTRACT_ID = "CAFI5QOTNLK5OIHEHGGQ7B22RN5IUOFGKKEID2OQCZSCJAQS4FLSS2DR";
const NETWORK_PASSPHRASE = Networks.TESTNET;

function fields(message: Uint8Array) {
  const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
  const decoder = new TextDecoder();
  let offset = 0;
  const domain = decoder.decode(message.subarray(offset, offset + ATTESTATION_DOMAIN.length));
  offset += ATTESTATION_DOMAIN.length;
  const networkId = message.subarray(offset, offset + 32);
  offset += 32;
  const contractLength = view.getUint32(offset, false);
  offset += 4;
  const contractId = decoder.decode(message.subarray(offset, offset + contractLength));
  offset += contractLength;
  const escrowId = view.getBigUint64(offset, false);
  offset += 8;
  const actionLength = view.getUint32(offset, false);
  offset += 4;
  const action = decoder.decode(message.subarray(offset, offset + actionLength));
  offset += actionLength;
  return { domain, networkId, contractId, escrowId, action, consumed: offset };
}

describe("buildAttestationMessage", () => {
  it("lays out every field the contract verifies", () => {
    const message = buildAttestationMessage({
      contractId: CONTRACT_ID,
      networkPassphrase: NETWORK_PASSPHRASE,
      escrowId: 42n,
    });

    const parsed = fields(message);
    expect(parsed.domain).toBe(ATTESTATION_DOMAIN);
    expect(Buffer.from(parsed.networkId).toString("hex")).toBe(
      Buffer.from(hash(Buffer.from(NETWORK_PASSPHRASE, "utf8"))).toString("hex"),
    );
    expect(parsed.contractId).toBe(CONTRACT_ID);
    expect(parsed.escrowId).toBe(42n);
    expect(parsed.action).toBe("release");
    // Nothing but the declared fields, with no padding.
    expect(parsed.consumed).toBe(message.length);
    expect(message.length).toBe(
      ATTESTATION_DOMAIN.length + 32 + 4 + CONTRACT_ID.length + 8 + 4 + "release".length,
    );
  });

  it("binds the message to the escrow id, contract and network", () => {
    const base = buildAttestationMessage({
      contractId: CONTRACT_ID,
      networkPassphrase: NETWORK_PASSPHRASE,
      escrowId: 1n,
    });
    const otherEscrow = buildAttestationMessage({
      contractId: CONTRACT_ID,
      networkPassphrase: NETWORK_PASSPHRASE,
      escrowId: 2n,
    });
    const otherNetwork = buildAttestationMessage({
      contractId: CONTRACT_ID,
      networkPassphrase: Networks.PUBLIC,
      escrowId: 1n,
    });
    const otherContract = buildAttestationMessage({
      contractId: Keypair.random().publicKey(),
      networkPassphrase: NETWORK_PASSPHRASE,
      escrowId: 1n,
    });

    expect(Buffer.from(base).equals(Buffer.from(otherEscrow))).toBe(false);
    expect(Buffer.from(base).equals(Buffer.from(otherNetwork))).toBe(false);
    expect(Buffer.from(base).equals(Buffer.from(otherContract))).toBe(false);
  });

  it("rejects unsupported actions and out-of-range escrow ids", () => {
    expect(() =>
      buildAttestationMessage({
        contractId: CONTRACT_ID,
        networkPassphrase: NETWORK_PASSPHRASE,
        escrowId: 1n,
        // @ts-expect-error — only "release" is supported by the contract.
        action: "refund",
      }),
    ).toThrow(/unsupported attestation action/);
    expect(() =>
      buildAttestationMessage({
        contractId: CONTRACT_ID,
        networkPassphrase: NETWORK_PASSPHRASE,
        escrowId: -1n,
      }),
    ).toThrow(/u64/);
  });
});

describe("signAttestation", () => {
  it("produces a 64-byte signature the releaser key verifies", async () => {
    const attester = Keypair.random();
    const message = buildAttestationMessage({
      contractId: CONTRACT_ID,
      networkPassphrase: NETWORK_PASSPHRASE,
      escrowId: 7n,
    });

    const signature = await signAttestation(message, attester);

    expect(signature).toBeInstanceOf(Uint8Array);
    expect(signature.length).toBe(64);
    expect(attester.verify(Buffer.from(message), Buffer.from(signature))).toBe(true);
  });

  it("rejects a signer that returns the wrong signature length", async () => {
    const message = buildAttestationMessage({
      contractId: CONTRACT_ID,
      networkPassphrase: NETWORK_PASSPHRASE,
      escrowId: 7n,
    });
    await expect(
      signAttestation(message, { sign: () => new Uint8Array(63) }),
    ).rejects.toThrow(/64 bytes/);
  });
});

describe("releaseWithAttestation input checks", () => {
  it("rejects a malformed signature before contacting the network", async () => {
    const client = new EscrowClient({
      contractId: CONTRACT_ID,
      rpcUrl: "https://127.0.0.1:1",
    });
    await expect(
      client.releaseWithAttestation({
        escrowId: 1n,
        signature: new Uint8Array(63),
        source: Keypair.random(),
      }),
    ).rejects.toThrow(/64 bytes/);
  });
});
