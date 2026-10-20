import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { FakeClock, FakeEscrowClient } from "../src/testing/fake-client.js";
import { registerEscrowConformanceSuite } from "./conformance.js";

const clock = new FakeClock(1_800_000_000n);
const client = () => new FakeEscrowClient({ contractId: "CFakeContract", clock: () => clock.now() });
const payer = Keypair.random();
const releaser = Keypair.random();
const stranger = Keypair.random();

registerEscrowConformanceSuite("FakeEscrowClient conformance", () => ({
  client: new FakeEscrowClient({ contractId: "CFakeContract" }),
  payer,
  payee: "GPAYEE",
  token: "CTOKEN",
  releaser,
  stranger,
  amount: 500n,
  conditionRef: "fake-conformance",
}));

async function fundedEscrow(fake: FakeEscrowClient, refundAfter?: bigint) {
  return fake.createEscrow({
    payer,
    payee: "GPAYEE",
    token: "CTOKEN",
    amount: 500n,
    conditionRef: "test-record",
    releaser: releaser.publicKey(),
    refundAfter,
  });
}

describe("FakeEscrowClient contract behavior", () => {
  it("creates an escrow and exposes its status and full record", async () => {
    const fake = client();
    const { escrowId, txHash } = await fundedEscrow(fake, clock.now() + 120n);

    expect(txHash).toBe("fake-tx-1");
    expect(await fake.getStatus(escrowId)).toBe("Funded");
    expect(await fake.getEscrow(escrowId)).toMatchObject({
      payer: payer.publicKey(),
      payee: "GPAYEE",
      token: "CTOKEN",
      amount: 500n,
      conditionRef: "test-record",
      releaser: releaser.publicKey(),
      refundAfter: clock.now() + 120n,
      status: "Funded",
    });
  });

  it("rejects invalid amounts and refund deadlines that are not in the future", async () => {
    const fake = client();
    const base = {
      payer, payee: "GPAYEE", token: "CTOKEN",
      conditionRef: "test-record", releaser: releaser.publicKey(),
    };

    await expect(fake.createEscrow({ ...base, amount: 0n })).rejects.toMatchObject({ code: "InvalidAmount" });
    await expect(fake.createEscrow({ ...base, amount: 1n, refundAfter: clock.now() }))
      .rejects.toMatchObject({ code: "InvalidRefundAfter" });
  });

  it("allows only the releaser to release and prevents a second settlement", async () => {
    const fake = client();
    const { escrowId } = await fundedEscrow(fake);

    await expect(fake.release({ escrowId, caller: stranger }))
      .rejects.toMatchObject({ code: "Unauthorized" });
    await fake.release({ escrowId, caller: releaser });
    expect(await fake.getStatus(escrowId)).toBe("Released");
    await expect(fake.refund({ escrowId, caller: releaser }))
      .rejects.toMatchObject({ code: "NotFunded" });
  });

  it("opens refund to any caller only after the deadline and keeps release available to the releaser", async () => {
    const fake = client();
    const deadline = clock.now() + 10n;
    const strangerRefund = await fundedEscrow(fake, deadline);
    const releaserRelease = await fundedEscrow(fake, deadline);

    await expect(fake.refund({ escrowId: strangerRefund.escrowId, caller: stranger }))
      .rejects.toMatchObject({ code: "Unauthorized" });
    clock.advanceBy(10);
    await fake.refund({ escrowId: strangerRefund.escrowId, caller: stranger });
    expect(await fake.getStatus(strangerRefund.escrowId)).toBe("Refunded");

    await fake.release({ escrowId: releaserRelease.escrowId, caller: releaser });
    expect(await fake.getStatus(releaserRelease.escrowId)).toBe("Released");
  });

  it("injects timeout, RPC failure, and a competing settlement race", async () => {
    const fake = client();
    const first = await fundedEscrow(fake);
    fake.failNext("getStatus", { kind: "timeout" });
    await expect(fake.getStatus(first.escrowId)).rejects.toMatchObject({
      code: "Timeout",
    });
    await expect(fake.getStatus(first.escrowId)).resolves.toBe("Funded");

    fake.failNext("getEscrow", { kind: "rpcError" });
    await expect(fake.getEscrow(first.escrowId)).rejects.toMatchObject({ code: "RpcError" });

    fake.failNext("release", { kind: "notFundedRace", winner: "Refunded" });
    await expect(fake.release({ escrowId: first.escrowId, caller: releaser }))
      .rejects.toMatchObject({ code: "NotFunded" });
    await expect(fake.getStatus(first.escrowId)).resolves.toBe("Refunded");
  });
});
