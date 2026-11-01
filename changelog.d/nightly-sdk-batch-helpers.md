Restored the SDK's batch helpers (`createEscrows`, `settleMany`,
`BatchPartialFailureError`, `MAX_BATCH_SIZE` and the related types), which #248
removed by accident when it merged from a stale branch, and put
`tests/batch.test.ts` back in `test:offline` so CI catches this if it happens
again. No contract change, so the generated bindings are unchanged.
