import { describe, expect, it } from "vitest";
import { reconcileSolvencyEvents, type SolvencyEvent } from "../src/solvency.js";

const XLM = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const TOKEN_B = "CBLB3N5SIYJ2IKVUDJYLXJGRMW2D4P7J7N2VUU3PZ5K5FZ7LCVQPYGQ";

describe("solvency event reconciliation", () => {
  it("sums funded escrows per token and removes released/refunded amounts", () => {
    const events: SolvencyEvent[] = [
      { kind: "created", escrowId: 0n, token: XLM, amount: 1_000n },
      { kind: "created", escrowId: 1n, token: XLM, amount: 500n },
      { kind: "released", escrowId: 0n, token: XLM, amount: 1_000n },
      { kind: "created", escrowId: 2n, token: TOKEN_B, amount: 700n },
      { kind: "refunded", escrowId: 2n, token: TOKEN_B, amount: 700n },
    ];
    const result = reconcileSolvencyEvents(events, new Map([[XLM, 600n], [TOKEN_B, 0n]]), [XLM, TOKEN_B]);
    expect(result).toEqual([
      { token: XLM, balance: 600n, liabilities: 500n, shortfall: 0n, solvent: true, complete: true },
      { token: TOKEN_B, balance: 0n, liabilities: 0n, shortfall: 0n, solvent: true, complete: true },
    ]);
  });

  it("reports a simulated clawback shortfall", () => {
    const result = reconcileSolvencyEvents(
      [
        { kind: "created", escrowId: 0n, token: XLM, amount: 1_000n },
        { kind: "created", escrowId: 1n, token: XLM, amount: 800n },
      ],
      new Map([[XLM, 1_700n]]),
      [XLM],
    );
    expect(result[0]).toMatchObject({ balance: 1_700n, liabilities: 1_800n, shortfall: 100n, solvent: false });
  });

  it("rejects a settlement event that does not match its creation", () => {
    expect(() => reconcileSolvencyEvents([
      { kind: "created", escrowId: 0n, token: XLM, amount: 1_000n },
      { kind: "refunded", escrowId: 0n, token: XLM, amount: 900n },
    ], new Map([[XLM, 1_000n]]), [XLM])).toThrow(/does not match/);
  });
});
