/**
 * Offline unit tests for the multisig releaser helpers (T1 mitigation).
 *
 * Everything here is client-side: the builder produces classic `setOptions`
 * transactions, the validator refuses lock-out configurations, and the
 * verifier reads a mocked Horizon account. No network calls, so this suite is
 * safe for CI.
 */
import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  buildMultisigSetup,
  dryRunMultisigSetup,
  MultisigLockOutError,
  MultisigValidationError,
  printMultisigDryRun,
  resolveMultisigPolicy,
  validateMultisigPolicy,
  verifyMultisig,
} from "../src/index.js";

type SetOptionsOp = {
  type: string;
  masterWeight?: number | null;
  lowThreshold?: number | null;
  medThreshold?: number | null;
  highThreshold?: number | null;
  signer?: { ed25519PublicKey: string; weight: number };
};

const account = Keypair.random().publicKey();
const signers = [Keypair.random().publicKey(), Keypair.random().publicKey(), Keypair.random().publicKey()];

function threeOfThree(overrides: Record<string, unknown> = {}) {
  return {
    account,
    signers: [
      { key: signers[0], weight: 1 },
      { key: signers[1], weight: 1 },
      { key: signers[2], weight: 1 },
    ],
    threshold: 2,
    ...overrides,
  } as never;
}

describe("buildMultisigSetup", () => {
  it("builds one atomic transaction with a setOptions per signer and the master key last", () => {
    const { policy, transactions, dryRun } = buildMultisigSetup(threeOfThree());

    expect(transactions).toHaveLength(1);
    const ops = transactions[0].operations as SetOptionsOp[];

    // 3 signers + the master-weight operation.
    expect(ops).toHaveLength(4);
    expect(ops.every((op) => op.type === "setOptions")).toBe(true);

    for (let i = 0; i < 3; i += 1) {
      expect(ops[i].signer).toEqual({ ed25519PublicKey: signers[i], weight: 1 });
    }
    // The master key weight change is last, after every signer is installed.
    expect(ops[3].signer).toBeUndefined();
    expect(ops[3].masterWeight).toBe(0);

    // Thresholds are applied for every operation, so the resulting policy is
    // complete regardless of which operation is inspected.
    for (const op of ops) {
      expect(op.lowThreshold).toBe(2);
      expect(op.medThreshold).toBe(2);
      expect(op.highThreshold).toBe(2);
    }

    expect(policy.removeMasterKey).toBe(true);
    expect(dryRun.operationCount).toBe(4);
    expect(dryRun.remainingWeight).toBe(3);
    expect(dryRun.masterKeyWeight).toBe(0);
    expect(dryRun.totalWeight).toBe(3);
  });

  it("keeps the master key when removeMasterKey is false", () => {
    const { transactions, dryRun } = buildMultisigSetup(
      threeOfThree({
        removeMasterKey: false,
        signers: [
          { key: account, weight: 1 },
          { key: signers[0], weight: 1 },
          { key: signers[1], weight: 1 },
        ],
      }),
    );

    const ops = transactions[0].operations as SetOptionsOp[];
    expect(ops).toHaveLength(2); // the account's own key is not a setOptions signer
    expect(ops.every((op) => op.masterWeight === undefined || op.masterWeight === null)).toBe(true);
    expect(dryRun.masterKeyWeight).toBe(1);
    expect(dryRun.totalWeight).toBe(3);
    expect(dryRun.remainingWeight).toBe(2);
  });

  it("accepts distinct weights that still meet the high threshold", () => {
    const { dryRun } = buildMultisigSetup(
      threeOfThree({
        signers: [
          { key: signers[0], weight: 127 },
          { key: signers[1], weight: 128 },
        ],
        threshold: 255,
      }),
    );
    expect(dryRun.remainingWeight).toBe(255);
    expect(dryRun.totalWeight).toBe(255);
  });
});

describe("lock-out validation", () => {
  it("refuses a policy whose remaining weight is below the high threshold", () => {
    expect(() =>
      buildMultisigSetup(
        threeOfThree({
          signers: [
            { key: signers[0], weight: 1 },
            { key: signers[1], weight: 1 },
          ],
          threshold: 3,
        }),
      ),
    ).toThrow(MultisigLockOutError);
  });

  it("refuses thresholds that are out of order", () => {
    expect(() =>
      validateMultisigPolicy(
        threeOfThree({ lowThreshold: 3, mediumThreshold: 2, highThreshold: 2 }),
      ),
    ).toThrow(/low <= medium <= high/);
  });

  it("refuses keeping the master key listed while also zeroing it", () => {
    expect(() =>
      validateMultisigPolicy(
        threeOfThree({
          signers: [
            { key: account, weight: 1 },
            { key: signers[0], weight: 1 },
            { key: signers[1], weight: 1 },
          ],
        }),
      ),
    ).toThrow(/removeMasterKey is true/);
  });
});

describe("structural validation", () => {
  it("refuses duplicate signer keys", () => {
    expect(() =>
      validateMultisigPolicy(
        threeOfThree({
          signers: [
            { key: signers[0], weight: 1 },
            { key: signers[0], weight: 1 },
          ],
        }),
      ),
    ).toThrow(MultisigValidationError);
  });

  it("refuses a zero or out-of-range weight", () => {
    expect(() =>
      validateMultisigPolicy(threeOfThree({ signers: [{ key: signers[0], weight: 0 }] })),
    ).toThrow(/weight/);
    expect(() =>
      validateMultisigPolicy(threeOfThree({ signers: [{ key: signers[0], weight: 256 }] })),
    ).toThrow(/weight/);
  });

  it("refuses an empty signer list and a zero threshold", () => {
    expect(() => validateMultisigPolicy(threeOfThree({ signers: [] }))).toThrow(/non-empty array/);
    expect(() => validateMultisigPolicy(threeOfThree({ threshold: 0 }))).toThrow(/threshold/);
  });
});

describe("dry run", () => {
  it("resolves defaults and renders a reviewable summary", () => {
    const dryRun = dryRunMultisigSetup(threeOfThree({ threshold: 2, highThreshold: 3 }));

    expect(dryRun.policy.highThreshold).toBe(3);
    expect(dryRun.policy.lowThreshold).toBe(2);
    expect(dryRun.operationCount).toBe(4);
    expect(dryRun.summary).toContain(`Multisig setup for ${account}`);
    expect(dryRun.summary).toContain("low=2 medium=2 high=3");
    expect(dryRun.summary).toContain(signers[0]);
    expect(dryRun.summary).toContain("Master key weight after setup: 0");
  });

  it("prints the summary and returns it", () => {
    const dryRun = dryRunMultisigSetup(threeOfThree());
    const calls: string[] = [];
    const original = console.log;
    console.log = (message: string) => {
      calls.push(message);
    };
    try {
      expect(printMultisigDryRun(dryRun)).toBe(dryRun.summary);
    } finally {
      console.log = original;
    }
    expect(calls).toEqual([dryRun.summary]);
  });
});

describe("verifyMultisig", () => {
  function server(thresholds: { low: number; medium: number; high: number }, weights: Record<string, number>) {
    return {
      async loadAccount(id: string) {
        return {
          thresholds: {
            low_threshold: thresholds.low,
            med_threshold: thresholds.medium,
            high_threshold: thresholds.high,
          },
          signers: Object.entries(weights).map(([key, weight]) => ({ key, weight })),
          accountId: () => id,
        } as never;
      },
    };
  }

  it("reports a match when on-chain state equals the policy", async () => {
    const result = await verifyMultisig(threeOfThree(), {
      server: server({ low: 2, medium: 2, high: 2 }, { [signers[0]]: 1, [signers[1]]: 1, [signers[2]]: 1 }),
    });

    expect(result.matches).toBe(true);
    expect(result.differences).toEqual([]);
    expect(result.onState.masterKeyWeight).toBe(0);
    expect(result.onState.totalWeight).toBe(3);
  });

  it("lists every difference from the intended policy", async () => {
    const result = await verifyMultisig(threeOfThree(), {
      server: server(
        { low: 1, medium: 2, high: 2 },
        { [account]: 1, [signers[0]]: 1, [Keypair.random().publicKey()]: 5 },
      ),
    });

    expect(result.matches).toBe(false);
    expect(result.differences).toEqual(
      expect.arrayContaining([
        "low threshold: expected 2, got 1",
        "master key weight: expected 0, got 1",
        `missing signer ${signers[1]} (expected weight 1)`,
        `missing signer ${signers[2]} (expected weight 1)`,
      ]),
    );
    expect(result.differences.some((d) => d.startsWith("unexpected signer"))).toBe(true);
  });
});

describe("resolveMultisigPolicy", () => {
  it("defaults every optional field without mutating the input", () => {
    const input = threeOfThree();
    const resolved = resolveMultisigPolicy(input);

    expect(resolved.lowThreshold).toBe(2);
    expect(resolved.mediumThreshold).toBe(2);
    expect(resolved.highThreshold).toBe(2);
    expect(resolved.removeMasterKey).toBe(true);
    expect(input.highThreshold).toBeUndefined();
  });
});
