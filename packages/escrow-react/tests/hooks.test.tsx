/**
 * React Testing Library tests for the escrow hooks (issues #126, #336, #337,
 * #338 and #339). A fake client means no RPC, no browser and no wallet.
 */
import { StrictMode, type ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_POLL_INTERVAL_MS,
  EscrowProvider,
  escrowKeys,
  isTerminalStatus,
  pooledEscrowPhase,
  useContribution,
  useEscrow,
  useEscrowActions,
  useEscrowEvents,
  useEscrowTimeline,
  usePooledEscrow,
  type ContributionRecord,
  type Escrow,
  type EscrowClientLike,
  type EscrowEvent,
  type EscrowStatus,
  type PooledEscrow,
} from "../src/index.js";

const payer = "GPAYER";
const payee = "GPAYEE";

function escrow(status: EscrowStatus = "Funded", refundAfter?: bigint, amount = 1_000_000n): Escrow {
  return {
    payer,
    payee,
    token: "CTOKEN",
    amount,
    conditionRef: "condition-1",
    releasers: ["GRELEASER"],
    threshold: 1,
    ...(refundAfter !== undefined ? { refundAfter } : {}),
    notifyPayee: false,
    refundTo: payer,
    requiresAcceptance: false,
    status,
  };
}

function pooledConfig(fundingTarget = 1_000_000n, fundingDeadline = 2_000n): PooledEscrow {
  return { fundingTarget, fundingDeadline };
}

function contribution(amount = 400_000n, refunded = false): ContributionRecord {
  return { amount, refunded };
}

function fakeClient(overrides: Partial<Record<keyof EscrowClientLike, unknown>> = {}) {
  return {
    getEscrow: vi.fn(async () => escrow()),
    getStatus: vi.fn(async () => "Funded" as EscrowStatus),
    createEscrow: vi.fn(async () => ({ escrowId: 2n, txHash: "create-hash" })),
    createQuorumEscrow: vi.fn(async () => ({ escrowId: 3n, txHash: "quorum-hash" })),
    release: vi.fn(async () => ({ txHash: "release-hash" })),
    refund: vi.fn(async () => ({ txHash: "refund-hash" })),
    releaseWithApprovals: vi.fn(async () => ({ txHash: "release-approvals-hash" })),
    refundWithApprovals: vi.fn(async () => ({ txHash: "refund-approvals-hash" })),
    accept: vi.fn(async () => ({ txHash: "accept-hash" })),
    cancel: vi.fn(async () => ({ txHash: "cancel-hash" })),
    topUp: vi.fn(async () => ({ txHash: "top-up-hash" })),
    contribute: vi.fn(async () => ({ txHash: "contribute-hash" })),
    claimRefund: vi.fn(async () => ({ txHash: "claim-hash" })),
    getPooled: vi.fn(async () => pooledConfig()),
    getContribution: vi.fn(async () => contribution()),
    subscribe: vi.fn(() => () => {}),
    ...overrides,
  } as unknown as EscrowClientLike & Record<string, ReturnType<typeof vi.fn>>;
}

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
}

function wrapperFor(client: EscrowClientLike, queryClient = makeQueryClient(), pollIntervalMs = DEFAULT_POLL_INTERVAL_MS) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <EscrowProvider client={client} pollIntervalMs={pollIntervalMs}>
          {children}
        </EscrowProvider>
      </QueryClientProvider>
    );
  };
}

function strictWrapperFor(client: EscrowClientLike) {
  const Base = wrapperFor(client);
  return function StrictWrapper({ children }: { children: ReactNode }) {
    return (
      <StrictMode>
        <Base>{children}</Base>
      </StrictMode>
    );
  };
}

/** A fake `subscribe` that tracks its live subscriptions and handlers. */
function subscriptionRegistry() {
  const live = new Set<() => void>();
  const handlers: Array<(event: EscrowEvent) => void> = [];
  const options: Array<{ cursor?: string; types?: string[]; escrowId?: bigint; onError?: (error: unknown) => void }> = [];
  const subscribe = vi.fn(
    (
      handler: (event: EscrowEvent) => void,
      opts?: { cursor?: string; types?: string[]; escrowId?: bigint; onError?: (error: unknown) => void },
    ) => {
      handlers.push(handler);
      options.push(opts ?? {});
      const stop = () => { live.delete(stop); };
      live.add(stop);
      return stop;
    },
  );
  return { subscribe, live, handlers, options };
}

function event(type: EscrowEvent["type"], escrowId: bigint, cursor: string): EscrowEvent {
  return { type, escrowId, ledger: 1, cursor, transactionHash: `tx-${cursor}`, data: {} } as EscrowEvent;
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("useEscrow", () => {
  it("loads one escrow and exposes it through React Query", async () => {
    const client = fakeClient();
    const { result } = renderHook(() => useEscrow(7n), { wrapper: wrapperFor(client) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toMatchObject({ payer, payee, status: "Funded", amount: 1_000_000n });
    expect(client.getEscrow).toHaveBeenCalledWith(7n);
  });

  it("stops polling as soon as a terminal status is observed", async () => {
    const client = fakeClient({
      getEscrow: vi
        .fn()
        .mockResolvedValueOnce(escrow("Funded"))
        .mockResolvedValueOnce(escrow("Released"))
        .mockResolvedValue(escrow("Released")),
    });
    const { result } = renderHook(() => useEscrow(1n), {
      wrapper: wrapperFor(client, makeQueryClient(), 20),
    });

    await waitFor(() => expect(result.current.data?.status).toBe("Released"));
    await waitFor(() => expect(client.getEscrow).toHaveBeenCalledTimes(2));

    // Give several would-be poll intervals a chance to fire.
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(client.getEscrow).toHaveBeenCalledTimes(2);
  });

  it("does not poll an escrow that is already terminal", async () => {
    const client = fakeClient({ getEscrow: vi.fn(async () => escrow("Refunded")) });
    const { result } = renderHook(() => useEscrow(2n), {
      wrapper: wrapperFor(client, makeQueryClient(), 20),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(client.getEscrow).toHaveBeenCalledTimes(1);
  });

  it("can be held until an id is known", async () => {
    const client = fakeClient();
    const { result } = renderHook(() => useEscrow(3n, { enabled: false }), { wrapper: wrapperFor(client) });

    expect(result.current.fetchStatus).toBe("idle");
    expect(client.getEscrow).not.toHaveBeenCalled();
  });
});

describe("terminal statuses (issue #336)", () => {
  it("treats Cancelled as final and leaves only Funded open", () => {
    expect(isTerminalStatus("Cancelled")).toBe(true);
    expect(isTerminalStatus("Released")).toBe(true);
    expect(isTerminalStatus("Refunded")).toBe(true);
    expect(isTerminalStatus("Funded")).toBe(false);
    expect(isTerminalStatus(undefined)).toBe(false);
    expect(isTerminalStatus(null)).toBe(false);
  });

  it("stops polling a cancelled escrow", async () => {
    const client = fakeClient({ getEscrow: vi.fn(async () => escrow("Cancelled")) });
    const { result } = renderHook(() => useEscrow(20n), {
      wrapper: wrapperFor(client, makeQueryClient(), 20),
    });

    await waitFor(() => expect(result.current.data?.status).toBe("Cancelled"));
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(client.getEscrow).toHaveBeenCalledTimes(1);
  });

  it("stops the countdown for a cancelled escrow", () => {
    vi.useFakeTimers();
    let clock = 0;
    const { result } = renderHook(() =>
      useEscrowTimeline(escrow("Cancelled", 10n), { now: () => clock, intervalMs: 1_000 }),
    );

    expect(result.current.isTerminal).toBe(true);
    expect(result.current.remainingMs).toBe(10_000);

    // No timer means the countdown cannot advance while the escrow is final.
    act(() => { clock = 5_000; vi.advanceTimersByTime(5_000); });
    expect(result.current.remainingMs).toBe(10_000);
  });
});

describe("useEscrowActions", () => {
  it("releases with the hook signer and invalidates the escrow cache", async () => {
    const signer = { address: "GSIGNER", signTransaction: vi.fn() } as never;
    const client = fakeClient();
    const queryClient = makeQueryClient();
    const wrapper = wrapperFor(client, queryClient);

    const state = renderHook(() => useEscrow(5n), { wrapper });
    await waitFor(() => expect(state.result.current.isSuccess).toBe(true));
    expect(client.getEscrow).toHaveBeenCalledTimes(1);

    const actions = renderHook(() => useEscrowActions(signer), { wrapper });
    let outcome!: Awaited<ReturnType<typeof actions.result.current.release>>;
    await act(async () => {
      outcome = await actions.result.current.release(5n);
    });

    expect(outcome).toEqual({ status: "success", data: { txHash: "release-hash" } });
    expect(client.release).toHaveBeenCalledWith({ escrowId: 5n, caller: signer });
    await waitFor(() => expect(client.getEscrow).toHaveBeenCalledTimes(2));
  });

  it("treats a wallet rejection as a normal outcome", async () => {
    const signer = { address: "GSIGNER", signTransaction: vi.fn() } as never;
    const client = fakeClient({
      release: vi.fn(async () => { throw { code: -4, message: "User declined" }; }),
    });
    const actions = renderHook(() => useEscrowActions(signer), { wrapper: wrapperFor(client) });

    let outcome!: Awaited<ReturnType<typeof actions.result.current.release>>;
    await act(async () => {
      outcome = await actions.result.current.release(9n);
    });

    expect(outcome).toEqual({ status: "rejected" });
    expect(actions.result.current.error).toBeNull();
  });

  it("creates an escrow with the signer as payer", async () => {
    const signer = { address: "GSIGNER", signTransaction: vi.fn() } as never;
    const client = fakeClient();
    const actions = renderHook(() => useEscrowActions(signer), { wrapper: wrapperFor(client) });

    let outcome!: Awaited<ReturnType<typeof actions.result.current.createEscrow>>;
    await act(async () => {
      outcome = await actions.result.current.createEscrow({
        payee,
        token: "CTOKEN",
        amount: 5n,
        conditionRef: "c",
        releaser: "GRELEASER",
      });
    });

    expect(outcome).toEqual({ status: "success", data: { escrowId: 2n, txHash: "create-hash" } });
    expect(client.createEscrow).toHaveBeenCalledWith(expect.objectContaining({ payer: signer, payee }));
  });

  it("defaults approvals to the hook signer", async () => {
    const signer = { address: "GSIGNER", signTransaction: vi.fn() } as never;
    const client = fakeClient();
    const actions = renderHook(() => useEscrowActions(signer), { wrapper: wrapperFor(client) });

    await act(async () => { await actions.result.current.releaseWithApprovals(4n); });

    expect(client.releaseWithApprovals).toHaveBeenCalledWith({ escrowId: 4n, approvers: [signer] });
  });

  it("explains the missing-signer error instead of signing with nothing", async () => {
    const client = fakeClient();
    const actions = renderHook(() => useEscrowActions(), { wrapper: wrapperFor(client) });

    await expect(actions.result.current.release(1n)).rejects.toThrow(/needs a signer/);
  });

  it("accepts as the payee and invalidates the escrow detail query", async () => {
    const signer = { address: "GPAYEE", signTransaction: vi.fn() } as never;
    const client = fakeClient();
    const wrapper = wrapperFor(client);
    const state = renderHook(() => useEscrow(31n), { wrapper });
    await waitFor(() => expect(state.result.current.isSuccess).toBe(true));

    const actions = renderHook(() => useEscrowActions(signer), { wrapper });
    let outcome!: Awaited<ReturnType<typeof actions.result.current.accept>>;
    await act(async () => { outcome = await actions.result.current.accept(31n); });

    expect(outcome).toEqual({ status: "success", data: { txHash: "accept-hash" } });
    expect(client.accept).toHaveBeenCalledWith({ escrowId: 31n, payee: signer });
    await waitFor(() => expect(client.getEscrow).toHaveBeenCalledTimes(2));
  });

  it("cancels as the payer and invalidates the escrow detail query", async () => {
    const signer = { address: "GPAYER", signTransaction: vi.fn() } as never;
    const client = fakeClient();
    const wrapper = wrapperFor(client);
    const state = renderHook(() => useEscrow(32n), { wrapper });
    await waitFor(() => expect(state.result.current.isSuccess).toBe(true));

    const actions = renderHook(() => useEscrowActions(signer), { wrapper });
    let outcome!: Awaited<ReturnType<typeof actions.result.current.cancel>>;
    await act(async () => { outcome = await actions.result.current.cancel(32n); });

    expect(outcome).toEqual({ status: "success", data: { txHash: "cancel-hash" } });
    expect(client.cancel).toHaveBeenCalledWith({ escrowId: 32n, payer: signer });
    await waitFor(() => expect(client.getEscrow).toHaveBeenCalledTimes(2));
  });

  it("tops up as the payer and invalidates the escrow detail query", async () => {
    const signer = { address: "GPAYER", signTransaction: vi.fn() } as never;
    const client = fakeClient();
    const wrapper = wrapperFor(client);
    const state = renderHook(() => useEscrow(33n), { wrapper });
    await waitFor(() => expect(state.result.current.isSuccess).toBe(true));

    const actions = renderHook(() => useEscrowActions(signer), { wrapper });
    let outcome!: Awaited<ReturnType<typeof actions.result.current.topUp>>;
    await act(async () => { outcome = await actions.result.current.topUp(33n, 250_000n); });

    expect(outcome).toEqual({ status: "success", data: { txHash: "top-up-hash" } });
    expect(client.topUp).toHaveBeenCalledWith({ escrowId: 33n, payer: signer, amount: 250_000n });
    await waitFor(() => expect(client.getEscrow).toHaveBeenCalledTimes(2));
  });

  it("surfaces EscrowPreconditionError as a typed failure result", async () => {
    const signer = { address: "GPAYER", signTransaction: vi.fn() } as never;
    const failure = Object.assign(new Error("top_up: escrow 34 is Refunded, not Funded."), {
      name: "EscrowPreconditionError",
      code: "NotFunded",
      method: "top_up",
    });
    const client = fakeClient({ topUp: vi.fn(async () => { throw failure; }) });
    const actions = renderHook(() => useEscrowActions(signer), { wrapper: wrapperFor(client) });

    let outcome!: Awaited<ReturnType<typeof actions.result.current.topUp>>;
    await act(async () => { outcome = await actions.result.current.topUp(34n, 1n); });

    expect(outcome).toEqual({
      status: "precondition",
      error: {
        name: "EscrowPreconditionError",
        code: "NotFunded",
        method: "top_up",
        message: "top_up: escrow 34 is Refunded, not Funded.",
      },
    });
    expect(actions.result.current.error).toBeNull();
  });

  it("still resolves a wallet rejection for accept", async () => {
    const signer = { address: "GPAYEE", signTransaction: vi.fn() } as never;
    const client = fakeClient({
      accept: vi.fn(async () => { throw { code: -4, message: "User declined" }; }),
    });
    const actions = renderHook(() => useEscrowActions(signer), { wrapper: wrapperFor(client) });

    let outcome!: Awaited<ReturnType<typeof actions.result.current.accept>>;
    await act(async () => { outcome = await actions.result.current.accept(35n); });

    expect(outcome).toEqual({ status: "rejected" });
  });
});

describe("usePooledEscrow (issue #338)", () => {
  it("derives the funding phase from the contract's boundary rules", () => {
    expect(pooledEscrowPhase(escrow("Funded", undefined, 400_000n), pooledConfig(1_000_000n, 2_000n), 1_000)).toBe("open");
    expect(pooledEscrowPhase(escrow("Funded", undefined, 1_000_000n), pooledConfig(1_000_000n, 2_000n), 1_000)).toBe("funded");
    // The deadline itself is already past the funding window.
    expect(pooledEscrowPhase(escrow("Funded", undefined, 400_000n), pooledConfig(1_000_000n, 2_000n), 2_000)).toBe("failed");
    expect(pooledEscrowPhase(escrow("Released", undefined, 1_000_000n), pooledConfig(1_000_000n, 2_000n), 1_000)).toBe("released");
    // A failed round that closed through `claimRefund` reads `Refunded`.
    expect(pooledEscrowPhase(escrow("Refunded", undefined, 0n), pooledConfig(1_000_000n, 2_000n), 3_000)).toBe("failed");
  });

  it("returns the escrow, funding config and open phase for an unfunded pool", async () => {
    const client = fakeClient({ getEscrow: vi.fn(async () => escrow("Funded", undefined, 400_000n)) });
    const { result } = renderHook(() => usePooledEscrow(40n, { now: () => 1_000 }), { wrapper: wrapperFor(client) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.escrow?.amount).toBe(400_000n);
    expect(result.current.pooled?.fundingTarget).toBe(1_000_000n);
    expect(result.current.phase).toBe("open");
    expect(result.current.isSettled).toBe(false);
    expect(client.getPooled).toHaveBeenCalledWith(40n);
  });

  it("reports funded once the target is reached", async () => {
    const client = fakeClient({ getEscrow: vi.fn(async () => escrow("Funded", undefined, 1_000_000n)) });
    const { result } = renderHook(() => usePooledEscrow(41n, { now: () => 1_000 }), { wrapper: wrapperFor(client) });

    await waitFor(() => expect(result.current.phase).toBe("funded"));
    expect(result.current.isSettled).toBe(false);
  });

  it("stops polling a failed pool even though it stays Funded on-chain", async () => {
    const client = fakeClient({
      getEscrow: vi.fn(async () => escrow("Funded", undefined, 400_000n)),
      getPooled: vi.fn(async () => pooledConfig(1_000_000n, 1_000n)),
    });
    const { result } = renderHook(() => usePooledEscrow(42n, { now: () => 2_000, pollIntervalMs: 20 }), {
      wrapper: wrapperFor(client),
    });

    await waitFor(() => expect(result.current.phase).toBe("failed"));
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(client.getEscrow).toHaveBeenCalledTimes(1);
    expect(client.getPooled).toHaveBeenCalledTimes(1);
  });

  it("stops polling once the pool is released", async () => {
    const client = fakeClient({ getEscrow: vi.fn(async () => escrow("Released", undefined, 1_000_000n)) });
    const { result } = renderHook(() => usePooledEscrow(43n, { now: () => 1_000, pollIntervalMs: 20 }), {
      wrapper: wrapperFor(client),
    });

    await waitFor(() => expect(result.current.phase).toBe("released"));
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(client.getEscrow).toHaveBeenCalledTimes(1);
    expect(client.getPooled).toHaveBeenCalledTimes(1);
  });

  it("keeps polling while the phase is open", async () => {
    const client = fakeClient({ getEscrow: vi.fn(async () => escrow("Funded", undefined, 400_000n)) });
    renderHook(() => usePooledEscrow(44n, { now: () => 1_000, pollIntervalMs: 20 }), {
      wrapper: wrapperFor(client),
    });

    await waitFor(() => expect(client.getPooled.mock.calls.length).toBeGreaterThan(1));
  });

  it("loads one contribution and stays idle without an address", async () => {
    const client = fakeClient();
    const loaded = renderHook(() => useContribution(45n, "GCONTRIBUTOR"), { wrapper: wrapperFor(client) });

    await waitFor(() => expect(loaded.result.current.isSuccess).toBe(true));
    expect(loaded.result.current.data).toEqual({ amount: 400_000n, refunded: false });
    expect(client.getContribution).toHaveBeenCalledWith(45n, "GCONTRIBUTOR");

    const empty = renderHook(() => useContribution(45n, undefined), { wrapper: wrapperFor(client) });
    expect(empty.result.current.fetchStatus).toBe("idle");
    expect(client.getContribution).toHaveBeenCalledTimes(1);
  });

  it("contributes and invalidates the pooled and contribution queries", async () => {
    const signer = { address: "GSIGNER", signTransaction: vi.fn() } as never;
    const client = fakeClient();
    const wrapper = wrapperFor(client);
    const pool = renderHook(() => usePooledEscrow(46n, { now: () => 1_000 }), { wrapper });
    await waitFor(() => expect(pool.result.current.isSuccess).toBe(true));
    const record = renderHook(() => useContribution(46n, "GSIGNER"), { wrapper });
    await waitFor(() => expect(record.result.current.isSuccess).toBe(true));

    const actions = renderHook(() => useEscrowActions(signer), { wrapper });
    let outcome!: Awaited<ReturnType<typeof actions.result.current.contribute>>;
    await act(async () => { outcome = await actions.result.current.contribute(46n, 250_000n); });

    expect(outcome).toEqual({ status: "success", data: { txHash: "contribute-hash" } });
    expect(client.contribute).toHaveBeenCalledWith({ escrowId: 46n, payer: signer, amount: 250_000n });
    await waitFor(() => expect(client.getPooled).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(client.getContribution).toHaveBeenCalledTimes(2));
  });

  it("claims a failed round and invalidates the pooled and contribution queries", async () => {
    const signer = { address: "GSIGNER", signTransaction: vi.fn() } as never;
    const client = fakeClient();
    const wrapper = wrapperFor(client);
    const pool = renderHook(() => usePooledEscrow(47n, { now: () => 3_000 }), { wrapper });
    await waitFor(() => expect(pool.result.current.isSuccess).toBe(true));
    const record = renderHook(() => useContribution(47n, "GSIGNER"), { wrapper });
    await waitFor(() => expect(record.result.current.isSuccess).toBe(true));

    const actions = renderHook(() => useEscrowActions(signer), { wrapper });
    let outcome!: Awaited<ReturnType<typeof actions.result.current.claimRefund>>;
    await act(async () => { outcome = await actions.result.current.claimRefund(47n); });

    expect(outcome).toEqual({ status: "success", data: { txHash: "claim-hash" } });
    expect(client.claimRefund).toHaveBeenCalledWith({ escrowId: 47n, contributor: signer });
    await waitFor(() => expect(client.getPooled).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(client.getContribution).toHaveBeenCalledTimes(2));
  });
});

describe("useEscrowEvents (issue #339)", () => {
  it("streams events into a bounded list and exposes the latest cursor", async () => {
    const registry = subscriptionRegistry();
    const client = fakeClient({ subscribe: registry.subscribe });
    const { result } = renderHook(() => useEscrowEvents({ escrowId: 50n, maxEvents: 2 }), {
      wrapper: wrapperFor(client),
    });

    await waitFor(() => expect(result.current.subscribed).toBe(true));
    expect(registry.subscribe).toHaveBeenCalledTimes(1);
    expect(registry.options[0]).toMatchObject({ escrowId: 50n });

    act(() => {
      registry.handlers[0](event("created", 50n, "cursor-1"));
      registry.handlers[0](event("released", 50n, "cursor-2"));
      registry.handlers[0](event("refunded", 50n, "cursor-3"));
    });

    expect(result.current.events.map((each) => each.cursor)).toEqual(["cursor-2", "cursor-3"]);
    expect(result.current.cursor).toBe("cursor-3");
    expect(result.current.error).toBeUndefined();
  });

  it("resumes from the provided cursor and cache key", async () => {
    const registry = subscriptionRegistry();
    const client = fakeClient({ subscribe: registry.subscribe });
    const { result } = renderHook(() => useEscrowEvents({ cursor: "saved-cursor" }), {
      wrapper: wrapperFor(client),
    });

    await waitFor(() => expect(result.current.subscribed).toBe(true));
    expect(registry.options[0]).toMatchObject({ cursor: "saved-cursor" });
    expect(result.current.cursor).toBe("saved-cursor");
  });

  it("keeps exactly one live subscription under StrictMode and stops it on unmount", async () => {
    const registry = subscriptionRegistry();
    const client = fakeClient({ subscribe: registry.subscribe });
    const { unmount } = renderHook(() => useEscrowEvents(), { wrapper: strictWrapperFor(client) });

    await waitFor(() => expect(registry.live.size).toBe(1));
    expect(registry.subscribe).toHaveBeenCalledTimes(2);

    unmount();
    expect(registry.live.size).toBe(0);
  });

  it("stops the previous subscription when the filter changes", async () => {
    const registry = subscriptionRegistry();
    const client = fakeClient({ subscribe: registry.subscribe });
    const { rerender } = renderHook(({ escrowId }) => useEscrowEvents({ escrowId }), {
      wrapper: wrapperFor(client),
      initialProps: { escrowId: 51n },
    });

    await waitFor(() => expect(registry.live.size).toBe(1));

    rerender({ escrowId: 52n });

    await waitFor(() => expect(registry.subscribe).toHaveBeenCalledTimes(2));
    expect(registry.live.size).toBe(1);
    expect(registry.options[1]).toMatchObject({ escrowId: 52n });
  });

  it("surfaces an expired cursor as state instead of crashing", async () => {
    const registry = subscriptionRegistry();
    const client = fakeClient({ subscribe: registry.subscribe });
    const { result } = renderHook(() => useEscrowEvents({ cursor: "too-old" }), {
      wrapper: wrapperFor(client),
    });

    await waitFor(() => expect(result.current.subscribed).toBe(true));
    const expired = Object.assign(new Error("cursor outside retention"), { name: "EventCursorExpiredError" });
    act(() => { registry.options[0].onError?.(expired); });

    expect(result.current.error).toBe(expired);
    expect(result.current.cursorExpired).toBe(true);
  });

  it("reports a client without subscribe as state", async () => {
    const client = fakeClient({ subscribe: undefined });
    const { result } = renderHook(() => useEscrowEvents(), { wrapper: wrapperFor(client) });

    await waitFor(() => expect(result.current.error).toBeDefined());
    expect(result.current.error?.message).toMatch(/subscribe\(\)/);
    expect(result.current.subscribed).toBe(false);
  });

  it("invalidates the detail query for escrows named in events", async () => {
    const registry = subscriptionRegistry();
    const client = fakeClient({ subscribe: registry.subscribe });
    const wrapper = wrapperFor(client);
    const state = renderHook(() => useEscrow(53n), { wrapper });
    await waitFor(() => expect(state.result.current.isSuccess).toBe(true));
    expect(client.getEscrow).toHaveBeenCalledTimes(1);

    renderHook(() => useEscrowEvents(), { wrapper });
    await waitFor(() => expect(registry.subscribe).toHaveBeenCalledTimes(1));

    act(() => { registry.handlers[0](event("released", 53n, "cursor-e")); });

    await waitFor(() => expect(client.getEscrow).toHaveBeenCalledTimes(2));
  });
});

describe("useEscrowTimeline", () => {
  it("counts down in ledger time and stops at the deadline", () => {
    vi.useFakeTimers();
    let clock = 0;
    const deadline = 10n;
    const { result } = renderHook(() =>
      useEscrowTimeline(escrow("Funded", deadline), { now: () => clock, intervalMs: 1_000 }),
    );

    expect(result.current.hasDeadline).toBe(true);
    expect(result.current.remainingMs).toBe(10_000);
    expect(result.current.expired).toBe(false);

    act(() => { clock = 4_000; vi.advanceTimersByTime(1_000); });
    expect(result.current.remainingMs).toBe(6_000);

    act(() => { clock = 12_000; vi.advanceTimersByTime(1_000); });
    expect(result.current.remainingMs).toBe(0);
    expect(result.current.expired).toBe(true);
  });

  it("applies a ledger clock offset instead of trusting the local clock", () => {
    const { result } = renderHook(() =>
      useEscrowTimeline(escrow("Funded", 100n), { now: () => 0, ledgerTimeOffsetMs: 95_000 }),
    );

    expect(result.current.ledgerNowMs).toBe(95_000);
    expect(result.current.remainingMs).toBe(5_000);
    expect(result.current.expired).toBe(false);
  });

  it("reports no deadline and never expires for an escrow without refundAfter", () => {
    const { result } = renderHook(() => useEscrowTimeline(escrow("Funded")));

    expect(result.current.hasDeadline).toBe(false);
    expect(result.current.remainingMs).toBeUndefined();
    expect(result.current.expired).toBe(false);
  });

  it("treats a settled escrow as terminal even past its old deadline", () => {
    const { result } = renderHook(() =>
      useEscrowTimeline(escrow("Released", 10n), { now: () => 1_000_000 }),
    );

    expect(result.current.isTerminal).toBe(true);
    expect(isTerminalStatus(result.current.status)).toBe(true);
  });
});

describe("cache keys", () => {
  it("scopes keys by client and stringifies the bigint id", () => {
    expect(escrowKeys.detail("contract", 9n)).toEqual(["docforum-escrow", "escrow", "contract", "9"]);
    expect(escrowKeys.all("contract")).toEqual(["docforum-escrow", "escrow", "contract"]);
    expect(escrowKeys.pooled("contract", 9n)).toEqual(["docforum-escrow", "escrow", "contract", "9", "pooled"]);
    expect(escrowKeys.contribution("contract", 9n, "G")).toEqual([
      "docforum-escrow",
      "escrow",
      "contract",
      "9",
      "contribution",
      "G",
    ]);
    expect(escrowKeys.contributions("contract", 9n)).toEqual([
      "docforum-escrow",
      "escrow",
      "contract",
      "9",
      "contribution",
    ]);
  });
});
