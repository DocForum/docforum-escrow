// Report writer: JSON for machines/artifacts, Markdown for the PR and the
// docs. Both are generated from the same run, so a pasted result can
// always be traced back to the JSON that produced it.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LoadConfig } from "./config.js";
import type { FailureCounter, PhaseResult } from "./metrics.js";
import type { VerificationReport } from "./verify.js";

export interface RunReport {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  config: Omit<LoadConfig, "amount"> & { amount: string };
  phases: PhaseResult[];
  failures: {
    total: number;
    byClass: Record<string, number>;
    examples: Array<{ phase: string; classification: string; message: string }>;
  };
  verification: VerificationReport & { duplicateIds: string[] };
  passed: boolean;
}

export async function writeReport(report: RunReport, outDir: string): Promise<string[]> {
  await mkdir(outDir, { recursive: true });
  const jsonPath = join(outDir, "load-report.json");
  const markdownPath = join(outDir, "load-report.md");
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, renderMarkdown(report), "utf8");
  return [jsonPath, markdownPath];
}

export function renderMarkdown(report: RunReport): string {
  const { config, phases, failures, verification } = report;
  const lines: string[] = [];
  lines.push("# Escrow load test — local network");
  lines.push("");
  lines.push(`- Run: ${report.startedAt} → ${report.finishedAt} (${seconds(report.durationMs)}s)`);
  lines.push(`- Contract: \`${config.contractId}\``);
  lines.push(`- Token: \`${config.token}\``);
  lines.push(`- RPC: \`${config.rpcUrl}\``);
  lines.push(`- Escrows requested: ${config.escrows}; channels: ${config.channels}; payees: ${config.payees}`);
  lines.push(`- Amount per escrow: ${config.amount} stroops; refund share: ${config.refundShare}`);
  lines.push("");
  lines.push("## Throughput and latency");
  lines.push("");
  lines.push("| Phase | Attempted | Succeeded | Failed | Duration (s) | Throughput (op/s) | p50 (ms) | p90 (ms) | p99 (ms) | max (ms) |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const phase of phases) {
    const latency = phase.latency;
    lines.push(
      `| ${phase.name} | ${phase.attempted} | ${phase.succeeded} | ${phase.failed} | ${seconds(phase.durationMs)} | ${phase.throughputPerSecond} | ${latency?.p50Ms ?? "—"} | ${latency?.p90Ms ?? "—"} | ${latency?.p99Ms ?? "—"} | ${latency?.maxMs ?? "—"} |`,
    );
  }
  lines.push("");
  lines.push("Latency is measured per transaction from submission to confirmed ledger");
  lines.push("inclusion (SDK `signAndSend`), so it includes RPC round trips.");
  lines.push("");
  lines.push("## Failures");
  lines.push("");
  lines.push(`Total: ${failures.total}`);
  if (failures.total > 0) {
    lines.push("");
    lines.push("| Class | Count |");
    lines.push("|---|---:|");
    for (const [name, count] of Object.entries(failures.byClass)) {
      lines.push(`| ${name} | ${count} |`);
    }
    lines.push("");
    lines.push("Examples:");
    lines.push("");
    for (const example of failures.examples) {
      lines.push(`- **${example.phase} / ${example.classification}**: ${example.message}`);
    }
  }
  lines.push("");
  lines.push("## Correctness verification");
  lines.push("");
  lines.push(`- Escrows checked: ${verification.checked}`);
  lines.push(`- Mismatches: ${verification.mismatches.length}`);
  lines.push(`- Duplicate ids: ${verification.duplicateIds.length}`);
  lines.push(`- Verdict: ${verification.passed ? "PASS" : "FAIL"}`);
  if (verification.mismatches.length > 0) {
    lines.push("");
    lines.push("| Escrow id | Expected | Actual |");
    lines.push("|---|---|---|");
    for (const mismatch of verification.mismatches.slice(0, 20)) {
      lines.push(`| ${mismatch.escrowId} | ${mismatch.expected} | ${mismatch.actual} |`);
    }
    if (verification.mismatches.length > 20) {
      lines.push("");
      lines.push(`(${verification.mismatches.length - 20} more in \`load-report.json\`)`);
    }
  }
  lines.push("");
  lines.push(`**Overall: ${report.passed ? "PASS" : "FAIL"}**`);
  lines.push("");
  return lines.join("\n");
}

function seconds(ms: number): number {
  return Math.round((ms / 1_000) * 100) / 100;
}
