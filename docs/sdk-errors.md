# SDK error handling

The SDK converts contract rejections and common RPC failures into
`EscrowError` subclasses exported from the package root. Contract errors
include the original numeric `code`; `ContractError` is the fallback for
codes added by a newer contract than the SDK knows about. Every converted
error retains the original thrown value in `cause`.

| Class | Meaning |
|---|---|
| `NotFoundError` | The requested escrow ID does not exist (contract code 1). |
| `InvalidAmountError` | The requested amount is invalid (code 2). |
| `UnauthorizedError` | The caller is not authorized (code 3). |
| `NotFundedError` | The escrow is no longer funded (code 4). |
| `InvalidRefundAfterError` | The refund deadline is invalid (code 5). |
| `BalanceMismatchError` | The token transfer did not fund the escrow exactly (code 6). |
| `ContractError` | An unrecognized contract error code; inspect `code`. |
| `SimulationFailure` | Transaction simulation failed. |
| `SubmissionFailure` | Transaction submission failed. |
| `RequestTimeoutError` | An RPC operation timed out. |
| `NetworkMismatchError` | The configured network passphrase does not match the RPC network. |

Existing calls need no changes. Catch the typed subclasses where an
integrator needs different recovery or messaging:

```ts
import { EscrowClient, NotFundedError, ContractError } from "@docforum/escrow-sdk";

try {
  await client.release({ escrowId, caller });
} catch (error) {
  if (error instanceof NotFundedError) {
    // The escrow has already been released or refunded.
  } else if (error instanceof ContractError) {
    // Preserve a useful fallback for errors introduced by a newer contract.
    console.error("Contract error code:", error.code);
  } else {
    throw error;
  }
}
```

The error classes are additive API surface; existing promise rejection
behavior remains, with more specific `Error` instances in place of generic
SDK/RPC errors. To regenerate the code-to-name mapping after changing the
Rust contract error enum, run `node sdk/scripts/check-contract-errors.mjs`.
CI runs the same script with `--check` and fails when generated data drifts.
