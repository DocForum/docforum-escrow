// Post-run correctness verification (issue #132): every escrow this run
// created must be in the terminal state the run intended. A throughput
// number without this check is meaningless — a fast run that leaves
// escrows Funded, or settled the wrong way, is a failed run.
import type { EscrowClient } from "@docforum/escrow-sdk";
import type { EscrowStatus } from "@docforum/escrow-sdk";

export interface ExpectedEscrow {
  escrowId: bigint;
  expectedFinalStatus: Extract<EscrowStatus, "Released" | "Refunded">;
}

export interface VerificationMismatch {
  escrowId: string;
  expected: string;
  actual: string;
}

export interface VerificationReport {
  checked: number;
  mismatches: VerificationMismatch[];
  passed: boolean;
}

export async function verifyFinalState(
  client: EscrowClient,
  expected: ExpectedEscrow[],
  concurrency: number,
): Promise<VerificationReport> {
  const mismatches: VerificationMismatch[] = [];
  let checked = 0;
  let next = 0;

  const worker = async () => {
    while (next < expected.length) {
      const index = next;
      next += 1;
      const escrow = expected[index]!;
      try {
        const actual = await client.getStatus(escrow.escrowId);
        checked += 1;
        if (actual !== escrow.expectedFinalStatus) {
          mismatches.push({
            escrowId: escrow.escrowId.toString(),
            expected: escrow.expectedFinalStatus,
            actual,
          });
        }
      } catch (error) {
        checked += 1;
        mismatches.push({
          escrowId: escrow.escrowId.toString(),
          expected: escrow.expectedFinalStatus,
          actual: `error: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  };

  const workers = Math.max(1, Math.min(concurrency, expected.length));
  await Promise.all(Array.from({ length: workers }, worker));

  return { checked, mismatches, passed: mismatches.length === 0 };
}

/**
 * A quick sanity check that the ids returned by concurrent creation are
 * unique. Duplicate ids would mean the run is verifying the wrong set of
 * escrows, so it is checked before the slower status pass.
 */
export function findDuplicateIds(expected: ExpectedEscrow[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const escrow of expected) {
    const id = escrow.escrowId.toString();
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return [...duplicates];
}
