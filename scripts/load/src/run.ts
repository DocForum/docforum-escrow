#!/usr/bin/env node
// High-volume create-and-settle load test for a LOCAL Stellar network
// (issue #132).
//
// Shape of the run:
//   1. Fund N channel accounts + M payees from the local Friendbot.
//   2. Create `--escrows` escrows through a ChannelAccountPool, one
//      in-flight transaction per channel. Each channel is the payer *and*
//      the escrow's releaser for its own escrows.
//   3. Settle them: each channel releases (or refunds, per
//      `--refund-share`) its own escrows. Because each escrow's releaser
//      is a channel account, settlement parallelism equals the channel
//      count instead of serialising on one hot releaser key.
//   4. Re-read every escrow's status and fail the run unless each one is
//      in its expected terminal state.
//
// Single-channel runs (`--channels 1`) are the baseline: they show the
// sequence-number contention the issue asks about. Compare against
// multi-channel runs to quantify it.
import { ChannelAccountPool, EscrowClient, Keypair } from "@docforum/escrow-sdk";
import { parseConfig } from "./config.js";
import { FailureCounter, LatencyRecorder, phaseResult } from "./metrics.js";
import { createFundedKeypairs, makeServer, waitForAccounts, waitForRpc } from "./network.js";
import { writeReport, type RunReport } from "./report.js";
import { findDuplicateIds, verifyFinalState, type ExpectedEscrow } from "./verify.js";

interface CreatedEscrow extends ExpectedEscrow {
  channel: Keypair;
}

const startedAt = new Date();
const startedMonotonic = performance.now();

function log(message: string): void {
  const elapsed = ((performance.now() - startedMonotonic) / 1_000).toFixed(1);
  process.stdout.write(`[load +${elapsed}s] ${message}\n`);
}

async function main(): Promise<void> {
  const config = parseConfig(process.argv.slice(2));
  log(
    `local-only run: ${config.escrows} escrows, ${config.channels} channel(s), ` +
      `${config.payees} payee(s), ${config.amount} stroops each`,
  );

  const server = makeServer(config.rpcUrl);
  await waitForRpc(server);
  log("local RPC is ready");

  const client = new EscrowClient({
    contractId: config.contractId,
    rpcUrl: config.rpcUrl,
    networkPassphrase: config.networkPassphrase,
  });

  log(`funding ${config.channels} channel account(s) and ${config.payees} payee(s) via Friendbot`);
  const channels = await createFundedKeypairs(config.friendbotUrl, config.channels);
  const payees = await createFundedKeypairs(config.friendbotUrl, config.payees);
  await waitForAccounts(server, [...channels, ...payees].map((keypair) => keypair.publicKey()));
  log("accounts are funded and visible");

  const runId = Date.now().toString(36);
  const refundCount = Math.round(config.escrows * config.refundShare);
  const pool = new ChannelAccountPool(channels);
  const createLatency = new LatencyRecorder();
  const settleLatency = new LatencyRecorder();
  const failures = new FailureCounter();
  const created: CreatedEscrow[] = [];

  // --- create -----------------------------------------------------------
  log("create phase starting");
  const createStart = performance.now();
  await Promise.all(
    Array.from({ length: config.escrows }, (_, index) =>
      pool.run(async (channel) => {
        const operationStart = performance.now();
        try {
          const { escrowId } = await client.createEscrow({
            payer: channel,
            payee: payees[index % payees.length]!.publicKey(),
            token: config.token,
            amount: config.amount,
            conditionRef: `load-${runId}-${index}`,
            releaser: channel.publicKey(),
          });
          createLatency.record(performance.now() - operationStart);
          created.push({
            escrowId,
            channel,
            expectedFinalStatus: index < refundCount ? "Refunded" : "Released",
          });
        } catch (error) {
          failures.record("create", error);
        }
      }),
    ),
  );
  const createDurationMs = performance.now() - createStart;
  log(`create phase done: ${created.length}/${config.escrows} funded`);

  // --- settle -----------------------------------------------------------
  // Group by releaser so each channel works only on escrows it can settle;
  // this is also what bounds in-flight transactions to one per channel.
  const byChannel = new Map<string, CreatedEscrow[]>();
  for (const escrow of created) {
    const publicKey = escrow.channel.publicKey();
    const bucket = byChannel.get(publicKey);
    if (bucket) bucket.push(escrow);
    else byChannel.set(publicKey, [escrow]);
  }

  log("settle phase starting");
  const settleStart = performance.now();
  await Promise.all(
    channels.map(async (channel) => {
      for (const escrow of byChannel.get(channel.publicKey()) ?? []) {
        const operationStart = performance.now();
        try {
          if (escrow.expectedFinalStatus === "Released") {
            await client.release({ escrowId: escrow.escrowId, caller: channel });
          } else {
            await client.refund({ escrowId: escrow.escrowId, caller: channel });
          }
          settleLatency.record(performance.now() - operationStart);
        } catch (error) {
          failures.record("settle", error);
        }
      }
    }),
  );
  const settleDurationMs = performance.now() - settleStart;
  log(`settle phase done: ${settleLatency.count}/${created.length} settled`);

  // --- verification -----------------------------------------------------
  log("verifying every created escrow's final state");
  const duplicateIds = findDuplicateIds(created);
  const verification = await verifyFinalState(client, created, config.verifyConcurrency);
  log(
    `verification: ${verification.checked} checked, ` +
      `${verification.mismatches.length} mismatch(es), ${duplicateIds.length} duplicate id(s)`,
  );

  const phases = [
    phaseResult("create", config.escrows, createLatency, createDurationMs),
    phaseResult("settle", created.length, settleLatency, settleDurationMs),
  ];
  const passed =
    failures.count <= config.maxFailures && verification.passed && duplicateIds.length === 0;

  const report: RunReport = {
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: performance.now() - startedMonotonic,
    config: { ...config, amount: config.amount.toString() },
    phases,
    failures: {
      total: failures.count,
      byClass: failures.asObject(),
      examples: failures.examples,
    },
    verification: { ...verification, duplicateIds },
    passed,
  };

  const [jsonPath, markdownPath] = await writeReport(report, config.outDir);
  for (const phase of phases) {
    log(
      `${phase.name}: ${phase.succeeded}/${phase.attempted} ok, ` +
        `${phase.throughputPerSecond} op/s, p50 ${phase.latency?.p50Ms ?? "—"}ms, ` +
        `p99 ${phase.latency?.p99Ms ?? "—"}ms`,
    );
  }
  log(`reports: ${jsonPath} ${markdownPath}`);

  if (!passed) {
    process.exitCode = 1;
    log("FAILED: see the report for failures and verification mismatches");
  } else {
    log("PASSED");
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`load test crashed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
