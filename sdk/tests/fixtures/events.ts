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
