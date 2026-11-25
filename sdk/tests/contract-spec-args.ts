// Shared offline helpers: check the arguments an EscrowClient method hands to
// the generated bindings against the repo's contract-spec.json snapshot, and
// encode them exactly as the bindings would (through the embedded contract
// spec), with no network. Not a test file itself.
import { readFileSync } from "node:fs";
import { Keypair, xdr } from "@stellar/stellar-sdk";
import { expect, vi } from "vitest";
import { Client as GeneratedClient } from "../src/generated/contract-client.js";
import { EscrowClient } from "../src/index.js";

interface SpecFunction {
  name: string;
  args: string;
  return: string;
}

const SPEC: { functions: SpecFunction[] } = JSON.parse(
  readFileSync(new URL("../../contract-spec.json", import.meta.url), "utf8"),
);

const RUST_TO_SCV: Record<string, string> = {
  Address: "scvAddress",
  i128: "scvI128",
  u64: "scvU64",
  u32: "scvU32",
  bool: "scvBool",
  String: "scvString",
};

/** `[name, rustType]` for each argument of `fn` in contract-spec.json, `env` excluded. */
export function specArgs(fn: string): Array<[string, string]> {
  const entry = SPEC.functions.find((f) => f.name === fn);
  if (!entry) throw new Error(`${fn} is not in contract-spec.json`);
  return entry.args
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith("env:"))
    .map((part) => {
      const [name, rust] = part.split(":").map((s) => s.trim());
      return [name, rust] as [string, string];
    });
}

const encoder = new GeneratedClient({
  contractId: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
  networkPassphrase: "Test SDF Network ; September 2015",
  rpcUrl: "https://127.0.0.1:1",
});

/** Encodes `args` the way the generated client does for `fn`. */
export function encodeArgs(fn: string, args: Record<string, unknown>): xdr.ScVal[] {
  return encoder.spec.funcArgsToScVals(fn, args);
}

/**
 * Asserts `args` names exactly the spec's parameters, in order, and that each
 * encodes to the spec's type (an `Option` may be void). Returns the encoding.
 */
export function expectMatchesSpec(fn: string, args: Record<string, unknown>): xdr.ScVal[] {
  const expected = specArgs(fn);
  expect(Object.keys(args)).toEqual(expected.map(([name]) => name));
  const encoded = encodeArgs(fn, args);
  expect(encoded).toHaveLength(expected.length);
  expected.forEach(([name, rust], index) => {
    const optional = rust.startsWith("Option<");
    const inner = optional ? rust.slice("Option<".length, -1) : rust;
    const kind = encoded[index].switch().name;
    if (optional && kind === "scvVoid") return;
    expect(kind, `${fn}.${name} (${rust})`).toBe(RUST_TO_SCV[inner]);
  });
  return encoded;
}

/** An EscrowClient with some members replaced; nothing reaches the network. */
export function makeClient(fakes: Record<string, unknown>, contractId = Keypair.random().publicKey()): EscrowClient {
  return Object.assign(new EscrowClient({ contractId, rpcUrl: "https://127.0.0.1:1" }), fakes);
}

/** A fake AssembledTransaction whose `send()` resolves with `value` and `hash`. */
export function sendableTx<T>(value: T, hash = "hash1") {
  const unwrap = vi.fn(() => value);
  return {
    isReadCall: false,
    sign: vi.fn(async () => {}),
    send: vi.fn(async () => ({ result: { unwrap }, sendTransactionResponse: { hash } })),
    unwrap,
  };
}

/** A fake AssembledTransaction whose `send()` rejects with `error` (a submission failure). */
export function failingSendTx(error: unknown) {
  return {
    isReadCall: false,
    sign: vi.fn(async () => {}),
    send: vi.fn(async () => {
      throw error;
    }),
  };
}

/** A read-call result whose `unwrap()` returns `value`. */
export function readResult<T>(value: T) {
  return { result: { unwrap: () => value } };
}

/** Resolves to the rejection of `promise` (fails the test if it resolves). */
export async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected the promise to reject");
    },
    (error: unknown) => error,
  );
}
