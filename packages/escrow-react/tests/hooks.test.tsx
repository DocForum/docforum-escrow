/**
 * React Testing Library tests for the escrow hooks (issue #126).
 * A fake client means no RPC, no browser and no wallet.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_POLL_INTERVAL_MS,
  EscrowProvider,
  escrowKeys,
  isTerminalStatus,
  useEscrow,
  useEscrowActions,
  useEscrowTimeline,
  type Escrow,
  type EscrowClientLike,
  type EscrowStatus,
} from "../src/index.js";

const payer = "GPAYER";
const payee = "GPAYEE";

function escrow(status: EscrowStatus = "Funded", refundAfter?: bigint): Escrow {
  return {
    payer,
    payee,
    token: "CTOKEN",
    amount: 1_000_000n,
    conditionRef: "condition-1",
    releasers: ["GRELEASER"],
    threshold: 1,
    ...(refundAfter !== undefined ? { refundAfter } : {}),
    notifyPayee: false,
    status,
  };
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
  });
});
