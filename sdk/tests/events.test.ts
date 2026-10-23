import { afterEach, describe, expect, it, vi } from "vitest";
import { Keypair, xdr } from "@stellar/stellar-sdk";
import { Server } from "@stellar/stellar-sdk/rpc";
import { EscrowClient, EventCursorExpiredError } from "../src/index.js";
import { createdEventFixture, unknownEventFixture } from "./fixtures/events.js";

const contractId = Keypair.random().publicKey();
const client = new EscrowClient({ contractId, rpcUrl: "https://rpc.example.test", verifyNetwork: false });

// Hydrate the committed XDR fixture into the SDK's decoded RPC response type.
const fixture = {
  id: createdEventFixture.id, type: "contract" as const, ledger: createdEventFixture.ledger,
  ledgerClosedAt: "2026-10-17T00:00:00Z", transactionIndex: createdEventFixture.transactionIndex, operationIndex: createdEventFixture.operationIndex,
  inSuccessfulContractCall: true, txHash: "a".repeat(64), contractId,
  topic: createdEventFixture.topicXdr.map((encoded) => xdr.ScVal.fromXDR(encoded, "base64")),
  value: xdr.ScVal.fromXDR(createdEventFixture.valueXdr, "base64"),
};
const response = { events: [fixture], cursor: fixture.id, latestLedger: 42, oldestLedger: 1, latestLedgerCloseTime: "", oldestLedgerCloseTime: "" };
const unknownFixture = { ...fixture, id: unknownEventFixture.id, ledger: unknownEventFixture.ledger, topic: unknownEventFixture.topicXdr.map((encoded) => xdr.ScVal.fromXDR(encoded, "base64")) };

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("EscrowClient event history", () => {
  it("decodes a recorded lifecycle event and applies escrow filters", async () => {
    const rpc = vi.spyOn(Server.prototype, "getEvents").mockResolvedValue(response as never);
    const page = await client.getEvents({ fromLedger: 42, types: ["created"], escrowId: 7n });
    expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ startLedger: 42 }));
    expect(page.nextCursor).toBe(fixture.id);
    expect(page.events).toEqual([expect.objectContaining({ type: "created", escrowId: 7n, ledger: 42, transactionHash: fixture.txHash })]);
    expect(page.events[0].data).toBe(250n);
  });

  it("rejects mixing a cursor with a ledger start", async () => {
    await expect(client.getEvents({ cursor: "c", fromLedger: 1 } as never)).rejects.toThrow(TypeError);
  });

  it("surfaces an unknown event topic without throwing", async () => {
    vi.spyOn(Server.prototype, "getEvents").mockResolvedValue({ ...response, events: [unknownFixture] } as never);
    const page = await client.getEvents({ cursor: "resume" });
    expect(page.events[0]).toMatchObject({ type: "unknown", eventName: "updated", escrowId: 8n });
  });

  it("surfaces RPC retention failures as a typed error", async () => {
    vi.spyOn(Server.prototype, "getEvents").mockRejectedValue(new Error("cursor is older than the oldest ledger retained"));
    await expect(client.getEvents({ cursor: "expired" })).rejects.toBeInstanceOf(EventCursorExpiredError);
  });

  it("applies handler back-pressure and stops without dropping queued page events", async () => {
    vi.useFakeTimers();
    const secondFixture = { ...fixture, id: "ledger-42:tx-0:event-1", topic: [fixture.topic[0], xdr.ScVal.fromXDR("AAAABQAAAAAAAAAI", "base64")] };
    vi.spyOn(Server.prototype, "getEvents").mockResolvedValue({ ...response, events: [fixture, secondFixture] } as never);
    const seen: bigint[] = [];
    let firstStarted!: () => void;
    let releaseFirst!: () => void;
    let secondDelivered!: () => void;
    const firstStartedPromise = new Promise<void>((resolve) => { firstStarted = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondDeliveredPromise = new Promise<void>((resolve) => { secondDelivered = resolve; });
    const stop = client.subscribe(async (event) => {
      seen.push(event.escrowId);
      if (seen.length === 1) { firstStarted(); await firstGate; }
      if (seen.length === 2) secondDelivered();
    }, { cursor: "resume", pollIntervalMs: 10 });
    await firstStartedPromise;
    expect(seen).toEqual([7n]);
    releaseFirst();
    await secondDeliveredPromise;
    stop();
    await vi.advanceTimersByTimeAsync(20);
    expect(seen).toEqual([7n, 8n]);
  });

  it("resumes from a saved event cursor without redelivering that event", async () => {
    let restarted!: () => void;
    const restartedRead = new Promise<void>((resolve) => { restarted = resolve; });
    vi.spyOn(Server.prototype, "getEvents").mockImplementation(async (request) => {
      if ("cursor" in request && request.cursor === fixture.id) {
        restarted();
        return { ...response, events: [], cursor: fixture.id } as never;
      }
      return response as never;
    });
    let eventCursor = "initial";
    let handled = 0;
    const firstDelivered = new Promise<void>((resolve) => {
      const stop = client.subscribe((event) => { eventCursor = event.cursor; handled++; resolve(); stop(); }, { cursor: "initial" });
    });
    await firstDelivered;
    const stopAfterResume = client.subscribe(() => { handled++; }, { cursor: eventCursor, pollIntervalMs: 10 });
    await restartedRead;
    stopAfterResume();
    expect(handled).toBe(1);
  });
});
