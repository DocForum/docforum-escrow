/** Recorded event fields from a Soroban RPC getEvents response. */
export const createdEventFixture = {
  id: "ledger-42:tx-0:event-0",
  ledger: 42,
  transactionIndex: 0,
  operationIndex: 0,
  txHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  topicXdr: ["AAAADwAAAAdjcmVhdGVkAA==", "AAAABQAAAAAAAAAH"],
  valueXdr: "AAAACQAAAAAAAAAAAAAAAAAAAPo=",
};

/** A later-version topic used to verify forward-compatible decoding. */
export const unknownEventFixture = {
  ...createdEventFixture,
  id: "ledger-43:tx-0:event-0",
  ledger: 43,
  topicXdr: ["AAAADwAAAAd1cGRhdGVkAA==", "AAAABQAAAAAAAAAI"],
};

// Non-lifecycle events (issue #327). `topUp`, `contributed` and `claimed` are
// copied from the contract's committed test snapshots
// (`contracts/escrow/test_snapshots/{top_up,contribute,claim_refund}_emits_an_event.1.json`),
// re-encoded from snapshot JSON to XDR with `stellar xdr encode --type ScVal`.
// The others have no snapshot yet; they are encoded the same way from the
// exact topic/data shapes the contract publishes (`releasers.rs`,
// `payee_transfer.rs`, `create.rs` accept, `settle.rs`, and the
// `#[contractevent]` structs in `types.rs` / `events.rs`, whose data is a
// map of the non-topic fields).
const snapshotContributor = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAARQG5";
const otherAddress = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHK3M";
const adminAddress = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEGWF";
const escrow3 = "AAAABQAAAAAAAAAD";

function nonLifecycle(n: number, topicXdr: string[], valueXdr: string) {
  return { ...createdEventFixture, id: `ledger-50:tx-0:event-${n}`, ledger: 50, topicXdr, valueXdr };
}

/** Each non-lifecycle event fixture with the fields it must decode to. */
export const nonLifecycleEventFixtures = {
  topUp: {
    raw: nonLifecycle(0, ["AAAADwAAAAZ0b3BfdXAAAA==", "AAAABQAAAAAAAAAA"], "AAAAEAAAAAEAAAACAAAACgAAAAAAAAAAAAAAAAAAAMgAAAAKAAAAAAAAAAAAAAAAAAAB9A=="),
    expected: { type: "topUp", escrowId: 0n, amount: 200n, newAmount: 500n },
  },
  contributed: {
    raw: nonLifecycle(1, ["AAAADwAAAAdjb250cmliAA==", "AAAABQAAAAAAAAAA"], "AAAAEAAAAAEAAAADAAAAEgAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAAAoAAAAAAAAAAAAAAAAAAAAeAAAACgAAAAAAAAAAAAAAAAAAAB4="),
    expected: { type: "contributed", escrowId: 0n, contributor: snapshotContributor, amount: 30n, funded: 30n },
  },
  claimed: {
    raw: nonLifecycle(2, ["AAAADwAAAAdjbGFpbWVkAA==", "AAAABQAAAAAAAAAA"], "AAAAEAAAAAEAAAACAAAAEgAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAAAoAAAAAAAAAAAAAAAAAAAAe"),
    expected: { type: "claimed", escrowId: 0n, contributor: snapshotContributor, amount: 30n },
  },
  accepted: {
    raw: nonLifecycle(3, ["AAAADwAAAAhhY2NlcHRlZA==", escrow3], "AAAAEAAAAAEAAAACAAAAEgAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAAAUAAAAAZVPxAA=="),
    expected: { type: "accepted", escrowId: 3n, payee: snapshotContributor, acceptedAt: 1700000000n },
  },
  rotated: {
    raw: nonLifecycle(4, ["AAAADwAAAAZyb3RhdGUAAA==", escrow3], "AAAAEAAAAAEAAAACAAAAEgAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAABIAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM="),
    expected: { type: "rotated", escrowId: 3n, oldReleaser: snapshotContributor, newReleaser: otherAddress },
  },
  payeeTransferred: {
    raw: nonLifecycle(5, ["AAAADwAAAAhwYXlfeGZlcg==", escrow3], "AAAAEAAAAAEAAAACAAAAEgAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAABIAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM="),
    expected: { type: "payeeTransferred", escrowId: 3n, oldPayee: snapshotContributor, newPayee: otherAddress },
  },
  settled: {
    raw: nonLifecycle(6, ["AAAADwAAAAdzZXR0bGVkAA==", escrow3], "AAAAEAAAAAEAAAACAAAACgAAAAAAAAAAAAAAAAAAADwAAAAKAAAAAAAAAAAAAAAAAAAAKA=="),
    expected: { type: "settled", escrowId: 3n, payeeAmount: 60n, payerAmount: 40n },
  },
  payeeRefunded: {
    raw: nonLifecycle(7, ["AAAADwAAAA5wYXllZV9yZWZ1bmRlZAAA", escrow3, "AAAAEgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAI=", "AAAAEgAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACA=="], "AAAAEQAAAAEAAAABAAAADwAAAAZhbW91bnQAAAAAAAoAAAAAAAAAAAAAAAAAAABk"),
    expected: { type: "payeeRefunded", escrowId: 3n, payer: adminAddress, payee: snapshotContributor, amount: 100n },
  },
  refundDeadlineExtended: {
    raw: nonLifecycle(8, ["AAAADwAAABhyZWZ1bmRfZGVhZGxpbmVfZXh0ZW5kZWQ=", escrow3], "AAAAEQAAAAEAAAACAAAADwAAAAxuZXdfZGVhZGxpbmUAAAAFAAAAAAAAB9AAAAAPAAAADG9sZF9kZWFkbGluZQAAAAUAAAAAAAAD6A=="),
    expected: { type: "refundDeadlineExtended", escrowId: 3n, oldDeadline: 1000n, newDeadline: 2000n },
  },
  paused: {
    raw: nonLifecycle(9, ["AAAADwAAAAZwYXVzZWQAAA==", "AAAAEgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAI="], "AAAAEQAAAAEAAAAA"),
    expected: { type: "paused", admin: adminAddress },
  },
  unpaused: {
    raw: nonLifecycle(10, ["AAAADwAAAAh1bnBhdXNlZA==", "AAAAEgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAI="], "AAAAEQAAAAEAAAAA"),
    expected: { type: "unpaused", admin: adminAddress },
  },
} as const;
