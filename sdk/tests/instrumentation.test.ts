/**
 * Offline tests for the optional OpenTelemetry / `onEvent` instrumentation
 * (issue #129). Nothing here touches an RPC: the private phase runner is
 * driven with a fake `AssembledTransaction`, exactly the seam the client uses.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { EscrowClient, networks } from "../src/index.js";
import {
  beginPhase,
  spanName,
  tracePhase,
  type EscrowInstrumentationEvent,
  type EscrowTracer,
} from "../src/instrumentation.js";

const contractId = Keypair.random().publicKey();

function fakeSent(hash = "b".repeat(64)) {
  return {
    sendTransactionResponse: { hash },
    getTransactionResponseAll: [{ status: "SUCCESS" }, { status: "SUCCESS" }],
    result: { unwrap: () => 0n },
  };
}

function invokeClient(options: ConstructorParameters<typeof EscrowClient>[0]) {
  const client = new EscrowClient(options);
  // Offline RPC double: answers the network preset check (when a preset or
  // verifyNetwork: true is configured) with the client's own passphrase, so
  // nothing here ever reaches a real RPC.
  const getNetwork = vi.fn(async () => ({
    passphrase: (client as unknown as { networkPassphrase: string }).networkPassphrase,
  }));
  (client as unknown as { rpc: unknown }).rpc = { getNetwork };
  const invoke = (client as unknown as {
    invoke: (
      method: string,
      escrowId: bigint | undefined,
      build: () => Promise<unknown>,
      hooks?: { beforeSign?: (tx: unknown) => Promise<void>; address?: string },
    ) => Promise<unknown>;
  }).invoke.bind(client);
  return { client, invoke, getNetwork };
}

function fakeTx(sent = fakeSent()) {
  const send = vi.fn(async (watcher?: { onSubmitted?: (r: { hash: string }) => void }) => {
    watcher?.onSubmitted?.({ hash: sent.sendTransactionResponse.hash });
    return sent;
  });
  return { isReadCall: false, sign: vi.fn(async () => {}), send };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("phase spans", () => {
  it("emits simulate, sign, submit and confirm events with standard attributes", async () => {
    const events: EscrowInstrumentationEvent[] = [];
    const { invoke } = invokeClient({
      contractId,
      rpcUrl: "https://rpc.example.test",
      onEvent: (event) => events.push(event),
    });
    const tx = fakeTx();

    await invoke("release", 42n, async () => tx, { address: Keypair.random().publicKey() });

    expect(events.map((event) => event.name)).toEqual(["simulate", "sign", "submit", "confirm"]);
    for (const event of events) {
      expect(event.spanName).toBe(spanName(event.name));
      expect(event.attributes["contract.id"]).toBe(contractId);
      expect(event.attributes["contract.function"]).toBe("release");
      expect(event.attributes["escrow.id"]).toBe("42");
      // Addresses are private by default (threat model T9).
      expect(event.attributes["account.address"]).toBeUndefined();
    }
    const [submit, confirm] = events.slice(-2);
    expect(submit.attributes["tx.hash"]).toBe("b".repeat(64));
    expect(confirm.attributes["tx.hash"]).toBe("b".repeat(64));
    expect(confirm.attributes["retry.count"]).toBe(1);
    expect(typeof confirm.durationMs).toBe("number");
  });

  it("feeds a tracer one span per phase and records the tx hash as an attribute", async () => {
    const spans: { name: string; attributes: Map<string, unknown>; ended: boolean }[] = [];
    const tracer: EscrowTracer = {
      startSpan(name, options) {
        const record = { name, attributes: new Map(Object.entries(options?.attributes ?? {})), ended: false };
        spans.push(record);
        return {
          setAttribute: (key, value) => record.attributes.set(key, value),
          setStatus: () => {},
          recordException: () => {},
          end: () => { record.ended = true; },
        };
      },
    };
    const { invoke } = invokeClient({ contractId, rpcUrl: "https://rpc.example.test", instrumentation: { tracer } });

    await invoke("release", 7n, async () => fakeTx());

    expect(spans.map((span) => span.name)).toEqual([
      "escrow.simulate",
      "escrow.sign",
      "escrow.submit",
      "escrow.confirm",
    ]);
    expect(spans.every((span) => span.ended)).toBe(true);
    expect(spans.at(-1)?.attributes.get("tx.hash")).toBe("b".repeat(64));
  });

  it("includes addresses only when explicitly opted in", async () => {
    const events: EscrowInstrumentationEvent[] = [];
    const { invoke } = invokeClient({
      contractId,
      rpcUrl: "https://rpc.example.test",
      instrumentation: { onEvent: (event) => events.push(event), includeAddresses: true },
    });
    const address = Keypair.random().publicKey();

    await invoke("refund", 1n, async () => fakeTx(), { address });

    expect(events[0].attributes["account.address"]).toBe(address);
  });

  it("marks a failed phase and still ends the span", async () => {
    const events: EscrowInstrumentationEvent[] = [];
    const { invoke } = invokeClient({
      contractId,
      rpcUrl: "https://rpc.example.test",
      onEvent: (event) => events.push(event),
    });
    const tx = fakeTx();
    tx.send.mockRejectedValueOnce(new Error("RPC unavailable"));

    await expect(invoke("release", 3n, async () => tx)).rejects.toThrow("RPC unavailable");

    const failed = events.filter((event) => event.error !== undefined);
    expect(failed.map((event) => event.name)).toEqual(["submit", "confirm"]);
  });

  it("does no timing work at all when instrumentation is disabled", async () => {
    const clock = vi.spyOn(Date, "now");
    const { invoke } = invokeClient({ contractId, rpcUrl: "https://rpc.example.test" });

    await invoke("release", 9n, async () => fakeTx());

    expect(clock).not.toHaveBeenCalled();
  });

  it("makes no network check without a preset, and none during construction", async () => {
    const { invoke, getNetwork } = invokeClient({ contractId, rpcUrl: "https://rpc.example.test" });
    expect(getNetwork).not.toHaveBeenCalled();

    await invoke("release", 5n, async () => fakeTx());

    expect(getNetwork).not.toHaveBeenCalled();
  });

  it("verifies a selected preset once, before the first submit, against the offline RPC double", async () => {
    const events: EscrowInstrumentationEvent[] = [];
    const { invoke, getNetwork } = invokeClient({
      contractId,
      network: networks.testnet,
      onEvent: (event) => events.push(event),
    });
    expect(getNetwork).not.toHaveBeenCalled();

    await invoke("release", 6n, async () => fakeTx());
    await invoke("release", 7n, async () => fakeTx());

    expect(getNetwork).toHaveBeenCalledTimes(1);
    expect(events.map((event) => event.name).slice(0, 4)).toEqual(["simulate", "sign", "submit", "confirm"]);
  });
});

describe("tracePhase / beginPhase helpers", () => {
  it("returns the work result and ignores a throwing observer", async () => {
    const result = await tracePhase(
      { onEvent: () => { throw new Error("observer boom"); } },
      "simulate",
      { "contract.id": "C1", "contract.function": "get_status" },
      async () => "ok",
    );
    expect(result).toBe("ok");
  });

  it("keeps a no-op handle when disabled", async () => {
    const handle = beginPhase(undefined, "submit", { "contract.id": "C1", "contract.function": "release" });
    expect(() => { handle.start(); handle.end(); }).not.toThrow();
  });
});
