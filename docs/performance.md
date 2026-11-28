# Performance: high-volume create and settle

**Local network only.** This document and `scripts/load/` describe a
throughput harness for a throwaway local Stellar network. It must never
be pointed at public testnet or mainnet — the script refuses any
non-loopback RPC URL (see `scripts/load/src/config.ts`), and
`ARCHITECTURE_ESSENTIALS.md` hard rule 4 keeps this repo testnet-only
until the Phase E4 security review lands. Local numbers are for
integration planning, not a production guarantee.

Issue: #132 (Phase E7 — verification, testing & release engineering).

## What is measured

| Measurement | How |
|---|---|
| Throughput | Successful `create_escrow` / `release`+`refund` operations ÷ phase wall-clock time, reported as op/s. |
| Latency distribution | Per-operation time from submission to confirmed ledger inclusion (SDK `signAndSend`, which includes RPC round trips), reported as min / p50 / p90 / p99 / max. |
| Failures | Every thrown operation is counted and classified (`sequence`, `rpc-throughput`, `confirmation-timeout`, `insufficient-funds`, `contract-rejection`, `malformed`, `other`), with up to five example messages. |
| Correctness | After the run, every created escrow is re-read with `get_status` and must be in the terminal state the run intended (`Released` or `Refunded`). Duplicate ids also fail the run. A run that creates a thousand escrows quickly but leaves any of them `Funded` is a failed run. |

The harness uses **channel accounts**: N funded source accounts, each
sourcing at most one in-flight transaction. Each channel is the payer
*and* the escrow's `releaser` for the escrows it creates, so settlement
parallelism is also N — no single key has to supply hundreds of
consecutive sequence numbers. `--channels 1` is the deliberate baseline
for the contention the issue describes.

The helper that implements this is exported from the SDK
(`ChannelAccountPool`, see below), so integrators can apply the same
pattern rather than copying the harness.

## Running it locally

Requires Docker, Rust with the `wasm32v1-none` target, the `stellar`
CLI, and Node 22+.

```bash
# 1. Throwaway local network (core + RPC + Friendbot on :8000)
docker run --rm -it -p 8000:8000 --name stellar stellar/quickstart:latest --local

# 2. Build and deploy the contract with an empty allowlist
cd contracts/escrow
cargo build --target wasm32v1-none --release
cd ../..
stellar network add local \
  --rpc-url http://localhost:8000/soroban/rpc \
  --network-passphrase "Standalone Network ; February 2017"
stellar keys generate deployer --network local
curl -s "http://localhost:8000/friendbot?addr=$(stellar keys address deployer)"
CONTRACT_ID=$(stellar contract deploy \
  --wasm contracts/escrow/target/wasm32v1-none/release/docforum_escrow.wasm \
  --source deployer --network local -- \
  --allowed_tokens '[]' --pause_admin "$(stellar keys address deployer)")
TOKEN_ID=$(stellar contract id asset --asset native --network local)

# 3. Run the load test
npm ci --prefix sdk && npm run build --prefix sdk
npm ci --prefix scripts/load
npm run load --prefix scripts/load -- \
  --contract-id "$CONTRACT_ID" \
  --token "$TOKEN_ID" \
  --escrows 2000 \
  --channels 20
```

The run writes `scripts/load/out/load-report.json` and
`scripts/load/out/load-report.md` (git-ignored) and exits non-zero if
failures exceed `--max-failures` (default 0) or any escrow's final state
is wrong.

The same thing runs in GitHub Actions: **Actions → Load test (local
network) → Run workflow**
(`.github/workflows/load-test.yml`, `workflow_dispatch`). It boots
Quickstart, deploys with `--allowed_tokens '[]'` and the deployer as `--pause_admin`, runs the harness, and
uploads the report. The job summary shows the generated Markdown.

## Reference results

No reference run is recorded here yet: the change that added this
harness was developed in an environment without a Docker daemon, so it
could not boot a local network. The manual workflow is the supported way
to produce the numbers — paste its `load-report.md` (or a trimmed table)
into this section and note the machine/commit it came from.

A useful reference set is one run per row, all on the same machine and
commit:

| Escrows | Channels | Refund share | Create op/s | Settle op/s | Create p99 | Settle p99 | Failures | Verified |
|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 2000 | 1  | 0.1 | _to record_ | _to record_ | _to record_ | _to record_ | _to record_ | _to record_ |
| 2000 | 20 | 0.1 | _to record_ | _to record_ | _to record_ | _to record_ | _to record_ | _to record_ |

Expect the single-channel row to be materially slower in **both** phases
and to show `sequence` failures if anything bypasses the one-in-flight
rule. That is the contention measurement, not a bug in the harness.

## Known bottlenecks and recommendations

1. **One source account is a hard ceiling.** A Stellar account's sequence
   number allows one in-flight transaction, so a single releaser settling
   hundreds of escrows serialises regardless of RPC capacity. Use channel
   accounts for releasers (one releaser identity per channel, as this
   harness does), or shard escrows across releasers at creation time.
2. **Channel count is the concurrency knob.** Throughput should scale
   with `--channels` until the local RPC or the ledger's close cadence
   becomes the limit. A flat line means the bottleneck moved to RPC
   throughput, not the contract.
3. **Ledger close time dominates latency.** Local Quickstart closes
   ledgers on a fixed cadence, so expect per-operation latency in that
   range with a long p99 from confirmation polling. Percentiles are more
   informative than the mean.
4. **Fees are not the limiter at this size.** Soroban resource fees are
   simulated per call; inclusion fees are negligible locally. Channel
   accounts each need their own XLM balance (Friendbot funds 10,000 XLM
   per account on Quickstart), so size `--channels` with fees plus
   escrowed amounts in mind.
5. **Failures should be zero by default.** `--max-failures 0` means any
   failure fails the run; the classification table distinguishes genuine
   contention (`sequence`), RPC overload (`rpc-throughput`), and
   misconfiguration (`insufficient-funds`, `malformed`).

## SDK: `ChannelAccountPool`

```ts
import { ChannelAccountPool, Keypair } from "@docforum/escrow-sdk";

const pool = new ChannelAccountPool([Keypair.random(), Keypair.random()]);
await Promise.all(
  escrows.map((escrow) =>
    pool.run(async (channel) => {
      // one in-flight transaction per channel; `channel` is exclusive here
      await client.createEscrow({ ...escrow, payer: channel, releaser: channel.publicKey() });
    }),
  ),
);
```

`acquire()`/`release()` are available for callers that do not want the
callback form; `run()` always releases, including on error. The pool
rejects duplicate or empty channel sets and can be closed to reject
queued waiters. It is network-free, so it is covered by offline tests in
`sdk/tests/channel-accounts.test.ts`.
