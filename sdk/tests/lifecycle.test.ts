// Offline tests for the lifecycle amendment methods (issue #84): topUp,
// accept, cancel, their client-side precondition checks, and the
// prepare → sign → submit flow for parties on different machines.
import { describe, expect, it, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  EscrowClient,
  EscrowPreconditionError,
  PREPARED_AUTH_TTL_LEDGERS,
  type Escrow,
  type PreparedLifecycleCall,
} from "../src/index.js";

const payer = Keypair.random();
const payee = Keypair.random();
const releaser = Keypair.random();

function escrow(overrides: Partial<Escrow> = {}): Escrow {
  return {
    payer: payer.publicKey(),
    payee: payee.publicKey(),
    token: Keypair.random().publicKey(),
    amount: 100n,
    conditionRef: "ref",
    releasers: [releaser.publicKey()],
    threshold: 1,
    notifyPayee: false,
    refundTo: payer.publicKey(),
    requiresAcceptance: true,
    status: "Funded",
    ...overrides,
  };
}

function makeClient(fakes: Record<string, unknown>): EscrowClient {
  return Object.assign(
    new EscrowClient({ contractId: Keypair.random().publicKey(), rpcUrl: "https://127.0.0.1:1" }),
    fakes,
  );
}

/** A fake AssembledTransaction whose `send()` reports `hash`. */
function sendableTx(hash = "hash1") {
  const unwrap = vi.fn();
  return {
    isReadCall: false,
    sign: vi.fn(async () => {}),
    send: vi.fn(async () => ({ result: { unwrap }, sendTransactionResponse: { hash } })),
    unwrap,
  };
}

async function expectPrecondition(promise: Promise<unknown>, code: string): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(EscrowPreconditionError);
  expect((error as EscrowPreconditionError).code).toBe(code);
}

describe("topUp", () => {
  it("calls top_up as the payer and returns the hash", async () => {
    const tx = sendableTx("topup-hash");
    const top_up = vi.fn(async () => tx);
    const client = makeClient({
      getEscrow: async () => escrow({ requiresAcceptance: false }),
      contractClient: () => ({ top_up }),
    });

    const result = await client.topUp({ escrowId: 4n, payer, amount: 25n });

    expect(result.txHash).toBe("topup-hash");
    expect(top_up).toHaveBeenCalledWith({ escrow_id: 4n, payer: payer.publicKey(), amount: 25n });
    expect(tx.unwrap).toHaveBeenCalledTimes(1);
  });

  it.each([0n, -1n])("rejects amount %s before any network call", async (amount) => {
    const client = makeClient({
      getEscrow: () => {
        throw new Error("must not reach the network");
      },
    });
    await expectPrecondition(client.topUp({ escrowId: 1n, payer, amount }), "InvalidAmount");
  });

  it("rejects a top-up from someone other than the payer", async () => {
    const client = makeClient({ getEscrow: async () => escrow() });
    await expectPrecondition(
      client.topUp({ escrowId: 1n, payer: Keypair.random(), amount: 1n }),
      "Unauthorized",
    );
  });

  it.each(["Released", "Refunded", "Cancelled"] as const)("rejects a %s escrow", async (status) => {
    const client = makeClient({ getEscrow: async () => escrow({ status }) });
    await expectPrecondition(client.topUp({ escrowId: 1n, payer, amount: 1n }), "NotFunded");
  });

  it("skips the read when checkPreconditions is false", async () => {
    const getEscrow = vi.fn();
    const client = makeClient({ getEscrow, contractClient: () => ({ top_up: async () => sendableTx() }) });
    await client.topUp({ escrowId: 1n, payer, amount: 1n, checkPreconditions: false });
    expect(getEscrow).not.toHaveBeenCalled();
  });
});

describe("accept", () => {
  it("calls accept as the payee", async () => {
    const accept = vi.fn(async () => sendableTx("accept-hash"));
    const client = makeClient({ getEscrow: async () => escrow(), contractClient: () => ({ accept }) });

    const result = await client.accept({ escrowId: 9n, payee });

    expect(result.txHash).toBe("accept-hash");
    expect(accept).toHaveBeenCalledWith({ escrow_id: 9n, payee: payee.publicKey() });
  });

  it("rejects a caller who is not the payee", async () => {
    const client = makeClient({ getEscrow: async () => escrow() });
    await expectPrecondition(client.accept({ escrowId: 1n, payee: payer }), "Unauthorized");
  });

  it("rejects an escrow without the acceptance gate", async () => {
    const client = makeClient({ getEscrow: async () => escrow({ requiresAcceptance: false }) });
    await expectPrecondition(client.accept({ escrowId: 1n, payee }), "AcceptanceNotConfigured");
  });

  it("rejects a second acceptance", async () => {
    const client = makeClient({ getEscrow: async () => escrow({ acceptedAt: 1_700_000_000n }) });
    await expectPrecondition(client.accept({ escrowId: 1n, payee }), "AlreadyAccepted");
  });

  it("checks the caller before the status, like the contract", async () => {
    const client = makeClient({ getEscrow: async () => escrow({ status: "Released" }) });
    await expectPrecondition(client.accept({ escrowId: 1n, payee: payer }), "Unauthorized");
  });
});

describe("cancel", () => {
  it("calls cancel as the payer", async () => {
    const cancel = vi.fn(async () => sendableTx("cancel-hash"));
    const client = makeClient({ getEscrow: async () => escrow(), contractClient: () => ({ cancel }) });

    const result = await client.cancel({ escrowId: 2n, payer });

    expect(result.txHash).toBe("cancel-hash");
    expect(cancel).toHaveBeenCalledWith({ escrow_id: 2n, payer: payer.publicKey() });
  });

  it("rejects cancel after the payee accepted", async () => {
    const client = makeClient({ getEscrow: async () => escrow({ acceptedAt: 5n }) });
    await expectPrecondition(client.cancel({ escrowId: 1n, payer }), "AlreadyAccepted");
  });

  it("rejects cancel without the acceptance gate", async () => {
    const client = makeClient({ getEscrow: async () => escrow({ requiresAcceptance: false }) });
    await expectPrecondition(client.cancel({ escrowId: 1n, payer }), "AcceptanceNotConfigured");
  });

  it("rejects cancel by the payee", async () => {
    const client = makeClient({ getEscrow: async () => escrow() });
    await expectPrecondition(client.cancel({ escrowId: 1n, payer: payee }), "Unauthorized");
  });

  it("names the method in the error", async () => {
    const client = makeClient({ getEscrow: async () => escrow({ status: "Refunded" }) });
    await expect(client.cancel({ escrowId: 1n, payer })).rejects.toThrow(/^cancel: /);
  });
});

/**
 * A fake AssembledTransaction that serializes to JSON and tracks which
 * auth entries are still unsigned, like the real one.
 */
function fakeAssembled(method: string, pending: string[]) {
  const state = { method, pending: [...pending] };
  const tx = {
    isReadCall: false,
    needsNonInvokerSigningBy: () => [...state.pending],
    toJSON: () => JSON.stringify(state),
    signAuthEntries: vi.fn(async ({ signAuthEntry }: { signAuthEntry: Keypair }) => {
      state.pending = state.pending.filter((a) => a !== signAuthEntry.publicKey());
    }),
  };
  return tx;
}

/** Restores a fake transaction from JSON, as `txFromJSON` would. */
function fakeFromJSON(json: string, sent: { hash: string; unwrap: ReturnType<typeof vi.fn> }) {
  const state = JSON.parse(json) as { method: string; pending: string[] };
  const restored = fakeAssembled(state.method, state.pending);
  return {
    ...restored,
    signAndSend: vi.fn(async () => ({ result: { unwrap: sent.unwrap }, sendTransactionResponse: { hash: sent.hash } })),
  };
}

describe("prepare → sign → submit", () => {
  const relayer = Keypair.random();
  const sent = { hash: "relayed-hash", unwrap: vi.fn() };

  function flowClient(pending: string[]) {
    return makeClient({
      getEscrow: async () => escrow({ requiresAcceptance: false }),
      rpc: { getLatestLedger: async () => ({ sequence: 1000 }) },
      contractClientForAddress: () => ({
        top_up: async () => fakeAssembled("top_up", pending),
        txFromJSON: (json: string) => fakeFromJSON(json, sent),
      }),
      contractClient: () => ({ txFromJSON: (json: string) => fakeFromJSON(json, sent) }),
    });
  }

  it("prepares a portable call listing the parties still to sign", async () => {
    const client = flowClient([payer.publicKey()]);
    const prepared = await client.prepareLifecycleCall({
      call: { method: "top_up", escrowId: 3n, payer: payer.publicKey(), amount: 10n },
      source: relayer.publicKey(),
    });

    expect(prepared.method).toBe("top_up");
    expect(prepared.source).toBe(relayer.publicKey());
    expect(prepared.pendingSigners).toEqual([payer.publicKey()]);
    expect(prepared.expiresAtLedger).toBe(1000 + PREPARED_AUTH_TTL_LEDGERS);
    // Survives a round trip through JSON, i.e. another process.
    expect(JSON.parse(JSON.stringify(prepared))).toEqual(prepared);
  });

  it("runs the flow with each party in its own client instance", async () => {
    const coSigner = Keypair.random();
    const pending = [payer.publicKey(), coSigner.publicKey()];

    // Machine A: the relayer prepares.
    const prepared = await flowClient(pending).prepareLifecycleCall({
      call: { method: "top_up", escrowId: 3n, payer: payer.publicKey(), amount: 10n },
      source: relayer.publicKey(),
      ttlLedgers: 20,
    });
    expect(prepared.expiresAtLedger).toBe(1020);

    // Machines B and C: each signer signs only its own auth entry.
    const afterPayer = await flowClient(pending).signLifecycleCall(JSON.parse(JSON.stringify(prepared)), payer);
    expect(afterPayer.pendingSigners).toEqual([coSigner.publicKey()]);
    await expect(flowClient(pending).submitLifecycleCall(afterPayer, relayer)).rejects.toThrow(/Still waiting/);

    const afterBoth = await flowClient(pending).signLifecycleCall(afterPayer, coSigner);
    expect(afterBoth.pendingSigners).toEqual([]);

    // Back on machine A: submit.
    const result = await flowClient(pending).submitLifecycleCall(afterBoth, relayer, "top_up");
    expect(result.txHash).toBe("relayed-hash");
    expect(sent.unwrap).toHaveBeenCalled();
  });

  it("refuses to sign for an address that has nothing pending", async () => {
    const client = flowClient([payer.publicKey()]);
    const prepared = await client.prepareLifecycleCall({
      call: { method: "top_up", escrowId: 3n, payer: payer.publicKey(), amount: 10n },
      source: relayer.publicKey(),
    });
    await expect(client.signLifecycleCall(prepared, Keypair.random())).rejects.toThrow(/no pending authorization/);
  });

  it("refuses a call submitted as a different method", async () => {
    const client = flowClient([]);
    const prepared: PreparedLifecycleCall = {
      method: "top_up",
      transaction: JSON.stringify({ method: "top_up", pending: [] }),
      source: relayer.publicKey(),
      pendingSigners: [],
      expiresAtLedger: 10,
    };
    await expect(client.submitLifecycleCall(prepared, relayer, "cancel")).rejects.toThrow(/not cancel/);
    await expect(
      client.submitLifecycleCall({ ...prepared, method: "accept" }, relayer),
    ).rejects.toThrow(/is for top_up/);
  });

  it("refuses a submit from anyone but the prepared source", async () => {
    const client = flowClient([]);
    const prepared = await client.prepareLifecycleCall({
      call: { method: "top_up", escrowId: 3n, payer: payer.publicKey(), amount: 10n },
      source: relayer.publicKey(),
    });
    await expect(client.submitLifecycleCall(prepared, payer)).rejects.toThrow(/submitted by its source/);
  });

  it("reports malformed JSON plainly", async () => {
    const client = flowClient([]);
    await expect(
      client.submitLifecycleCall(
        { method: "top_up", transaction: "{", source: relayer.publicKey(), pendingSigners: [], expiresAtLedger: 1 },
        relayer,
      ),
    ).rejects.toThrow(/not valid JSON/);
  });

  it("checks preconditions before simulating", async () => {
    const client = makeClient({ getEscrow: async () => escrow({ status: "Released" }) });
    await expectPrecondition(
      client.prepareLifecycleCall({
        call: { method: "top_up", escrowId: 3n, payer: payer.publicKey(), amount: 10n },
      }),
      "NotFunded",
    );
  });

  it("defaults the source to the call's own signer", async () => {
    const client = makeClient({
      getEscrow: async () => escrow(),
      rpc: { getLatestLedger: async () => ({ sequence: 1 }) },
      contractClientForAddress: () => ({ accept: async () => fakeAssembled("accept", []) }),
    });
    const prepared = await client.prepareLifecycleCall({
      call: { method: "accept", escrowId: 3n, payee: payee.publicKey() },
    });
    expect(prepared.source).toBe(payee.publicKey());
    expect(prepared.pendingSigners).toEqual([]);
  });
});

describe("createEscrow with requiresAcceptance", () => {
  const base = {
    payer,
    payee: payee.publicKey(),
    token: Keypair.random().publicKey(),
    amount: 10n,
    conditionRef: "ref",
    releaser: releaser.publicKey(),
  };

  it("uses create_escrow_with_acceptance", async () => {
    const unwrap = vi.fn(() => 12n);
    const create_escrow_with_acceptance = vi.fn(async () => ({
      isReadCall: false,
      sign: async () => {},
      send: async () => ({ result: { unwrap }, sendTransactionResponse: { hash: "h" } }),
    }));
    const client = makeClient({ contractClient: () => ({ create_escrow_with_acceptance }) });

    const result = await client.createEscrow({ ...base, requiresAcceptance: true });

    expect(result.escrowId).toBe(12n);
    expect(create_escrow_with_acceptance).toHaveBeenCalledWith(
      expect.objectContaining({ requires_acceptance: true, payer: payer.publicKey(), releaser: releaser.publicKey() }),
    );
  });

  it("rejects combinations the contract has no entry point for", async () => {
    const client = makeClient({ contractClient: () => ({}) });
    await expect(client.createEscrow({ ...base, requiresAcceptance: true, notifyPayee: true })).rejects.toThrow(
      /cannot be combined/,
    );
    await expect(
      client.createEscrow({ ...base, requiresAcceptance: true, releaseNotBefore: 5n }),
    ).rejects.toThrow(/cannot be combined/);
  });
});
