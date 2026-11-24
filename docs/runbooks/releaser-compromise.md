# Releaser compromise response

Threat model T1: whoever holds a leaked `releaser` key can call `release` or
`refund` on every still-`Funded` escrow it controls and pick either outcome.
Funds still only go to the stored `payee` or `refund_to`, so the response is
to settle every open escrow correctly before the attacker does. Testnet only
until ROADMAP.md Phase E4's security review is done.

## Who does what

- **Incident lead (integrator on-call):** declares the incident, owns the
  timeline, and decides when the race is over.
- **Outcome owner (integrator / service owner):** decides release or refund
  for each escrow and signs off the outcome file. Only they know the right
  outcome; nobody guesses one.
- **Operator:** holds the releaser key, runs `scripts/settle-outcomes.py`,
  and reports failures back to the lead.

## 1. Detect

Treat any of these as a possible compromise:

- `released` or `refunded` events (indexer `EscrowEvent`, or contract events)
  that your own service did not submit.
- Transactions signed by the releaser account that are not in your service's
  submission log, or the account's sequence number moving unexpectedly.
- The key appearing anywhere it should not: logs, a repository, a ticket.

Preserve the unexpected transaction hashes and the affected contract ID.

## 2. Decide

- Is the releaser the M-of-N custom account (`contracts/releaser-account/`,
  ADR 0005) and fewer than the threshold of signers leaked? Remove the
  leaked signer through the account's threshold-signed management path; the
  race may not be needed.
- Can the payer authorize a rotation (ADR 0009, two-party releaser
  rotation)? Rotate escrows the payer
  can co-sign to a fresh releaser. Rotation cannot undo a settlement that
  already landed.
- Otherwise, race the attacker: settle every `Funded` escrow with the
  approved outcome, using the same key. Escrows nobody can settle correctly
  are left for the `refund_after` timeout path.

## 3. Contain

Stop creating escrows with the key. Export every `Funded` escrow whose
releaser set contains the key, for example from the indexer's `Escrow`
entities (`status` and `releasers`) or the SDK's `EscrowIndexerClient`.
The outcome owner writes the outcome file from that list:

```json
{"escrows": [{"id": 12, "action": "release"}, {"id": 13, "action": "refund"}]}
```

Each `id` must be a non-negative integer and appear once; `action` must be
`release` or `refund`. The tool refuses anything else.

## 4. Settle (resumable)

Run the tool with the outcome file and a submit command. The command is the
operator's own signer; `{id}` and `{action}` are substituted per escrow, and
it is run without a shell. It must exit 0 only on success and print the
transaction hash as the last line of stdout:

```bash
python3 scripts/settle-outcomes.py outcomes.json --submit-cmd \
  'stellar contract invoke --id C... --source releaser --network testnet -- {action} --escrow_id {id} --caller G...'
```

Without `--submit-cmd` the tool only prints the pending work as JSON lines,
which is a safe way to check the file first.

**State file.** Progress lives in `outcomes.json.state.jsonl` next to the
outcome file (change it with `--state PATH`). It holds one JSON line per
escrow that settled successfully, with the transaction hash:

```json
{"action": "release", "id": 12, "tx": "<hash>"}
```

The file is rewritten atomically (temp file, fsync, rename) after every
successful submission, so a crash or kill leaves the last complete state.
Keep it with the incident record: it is the list of transactions this
response submitted.

**Resume.** Re-run the same command. Ids already in the state file are
skipped; everything else, including earlier failures, is submitted again.
A failed submission (rate limit, fee spike, timeout) does not stop the run:
the tool carries on with the remaining escrows, prints each failure, and
exits 1 with the ids to retry. The tool refuses to run if the state file
records an escrow with a different action than the outcome file now says.

**The gap between landing and recording.** If the tool dies after a
transaction landed but before the state file was written, or a submission
timed out, the next run submits that escrow again. The contract rejects the
second settlement (`NotFunded`, error #4), so the tool reports it as failed.
Check those ids with `get_status`; if the status matches the outcome, the
earlier transaction landed.

Submissions run one at a time: transactions from one source account share a
sequence number, so parallel submits from the same key would collide.

### Escrows with a payee callback (release only)

Release escrows created with `notify_payee` in **their own single-op
transaction**, never in a shared `settle_many` batch. The callback runs after
the payout, so a payee contract that fails it on demand would revert the
whole batch and take every other escrow in it down with it (issue #367,
ADR 0012, threat model T11). `scripts/settle-outcomes.py` already submits one
escrow per transaction, so the outcome file needs no change; the rule only
constrains any faster path you build around it, such as a raw `settle_many`
batch.

Find these escrows before settling: `get_escrow` returns `notify_payee`, and
the indexer's `Escrow.notifyPayee` carries the same flag. For a `release`
outcome, settle it alone and treat `CallbackFailed` (error 9) as "the payee's
callback refused" — the escrow is untouched, so retry later or hand it to the
outcome owner. **Refunds are exempt:** `refund` and a `Refund` batch op never
invoke the payee callback, so `notify_payee` refund escrows can be settled in
normal batches.

## 5. Verify

Reconcile every escrow in the outcome file: status is `Released` or
`Refunded` as approved, and the destination matches the stored payee or
`refund_to`. Compare the state file's hashes against the releaser account's
transactions; anything else is the attacker's.

## 6. Review

Rotate keys, write up the timeline, and keep the old deployment and contract
IDs for reconciliation.

## Drill record

The issue asks for a testnet drill with 50 or more escrows. It has not been
run yet. Record it here when it is: date, contract ID, escrow count, elapsed
time, failed submissions, and the point the run was resumed from.

| Date | Contract | Escrows | Elapsed | Failed submissions | Resumed from |
| --- | --- | --- | --- | --- | --- |
| not yet run | | | | | |
