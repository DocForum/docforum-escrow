// Throughput, latency distribution and failure classification for the
// local load test (issue #132). Everything is recorded per operation, so
// percentiles come from the actual submission-to-confirmation timings,
// not from a sampled subset.

export interface LatencyStats {
  count: number;
  minMs: number;
  p50Ms: number;
  p90Ms: number;
  p99Ms: number;
  maxMs: number;
  meanMs: number;
}

export class LatencyRecorder {
  private readonly samples: number[] = [];

  record(durationMs: number): void {
    this.samples.push(durationMs);
  }

  get count(): number {
    return this.samples.length;
  }

  stats(): LatencyStats | null {
    if (this.samples.length === 0) return null;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const percentile = (p: number) => {
      const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
      return sorted[Math.max(0, index)]!;
    };
    const sum = sorted.reduce((total, value) => total + value, 0);
    return {
      count: sorted.length,
      minMs: round(sorted[0]!),
      p50Ms: round(percentile(50)),
      p90Ms: round(percentile(90)),
      p99Ms: round(percentile(99)),
      maxMs: round(sorted[sorted.length - 1]!),
      meanMs: round(sum / sorted.length),
    };
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export type FailureClass =
  | "sequence"
  | "rpc-throughput"
  | "confirmation-timeout"
  | "insufficient-funds"
  | "contract-rejection"
  | "malformed"
  | "other";

const CLASSIFIERS: Array<[FailureClass, RegExp]> = [
  ["sequence", /txbadseq|tx_bad_seq|bad sequence|sequence number/i],
  ["rpc-throughput", /try_again_later|429|rate limit|too many requests|overloaded|timeout.*rpc/i],
  ["confirmation-timeout", /timed out|timeout|not found|notfound|still pending|mempool/i],
  ["insufficient-funds", /insufficient|balance|op_underfunded|tx_insufficient/i],
  ["contract-rejection", /unauthorized|notfunded|tokennotallowed|invalidamount|contract, #\d/i],
  ["malformed", /invalid|decod|xdr|bad request|400/i],
];

export function classifyFailure(error: unknown): FailureClass {
  const message = error instanceof Error ? error.message : String(error);
  for (const [name, pattern] of CLASSIFIERS) {
    if (pattern.test(message)) return name;
  }
  return "other";
}

export class FailureCounter {
  readonly byClass = new Map<FailureClass, number>();
  readonly examples: Array<{ phase: string; classification: FailureClass; message: string }> = [];
  private total = 0;

  record(phase: string, error: unknown): void {
    this.total += 1;
    const classification = classifyFailure(error);
    this.byClass.set(classification, (this.byClass.get(classification) ?? 0) + 1);
    if (this.examples.length < 5) {
      this.examples.push({
        phase,
        classification,
        message: (error instanceof Error ? error.message : String(error)).slice(0, 400),
      });
    }
  }

  get count(): number {
    return this.total;
  }

  asObject(): Record<FailureClass, number> {
    const result = {} as Record<FailureClass, number>;
    for (const [name, count] of this.byClass) result[name] = count;
    return result;
  }
}

export interface PhaseResult {
  name: string;
  attempted: number;
  succeeded: number;
  failed: number;
  durationMs: number;
  throughputPerSecond: number;
  latency: LatencyStats | null;
}

export function phaseResult(
  name: string,
  attempted: number,
  recorder: LatencyRecorder,
  durationMs: number,
): PhaseResult {
  return {
    name,
    attempted,
    succeeded: recorder.count,
    failed: attempted - recorder.count,
    durationMs: round(durationMs),
    throughputPerSecond: durationMs > 0 ? round((recorder.count / durationMs) * 1_000) : 0,
    latency: recorder.stats(),
  };
}
