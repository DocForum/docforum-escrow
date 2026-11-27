# Integrator Guide: Escrow Creation Entry Points & Options Matrix

This guide documents the creation entry points available in `docforum_escrow`
and the specific options supported by each function.

Because contract entry points take explicit arguments, different entry points
support different combinations of features. Integrators can consult this matrix
to select the correct creation function or SDK call for their integration needs.

---

## 1. Feature Support Matrix

The table below lists each on-chain creation entry point and whether it supports
individual creation options:

| Entry Point | `fee_recipient` / `fee_bps` | `refund_to` | `notify_payee` | `release_not_before` | Payee acceptance | Releaser quorum (`threshold` > 1) | Unique ref (`unique_ref`) | Batch items | Matching SDK Method |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| `create_escrow` | Yes | Yes | Yes | No | No | No (1-of-1) | No | No | `client.createEscrow(...)` |
| `create_escrow_release_time` | Yes | Yes | Yes | Yes | No | No (1-of-1) | No | No | `client.createEscrow({ releaseNotBefore, ... })` |
| `create_escrow_with_acceptance` | No | Yes | No | No | Yes | No (1-of-1) | No | No | `client.createEscrow({ requiresAcceptance: true, ... })` |
| `create_escrow_with_releasers` | No | Yes | Yes | No | No | Yes (M-of-N) | No | No | `client.createQuorumEscrow(...)` |
| `create_escrow_with_uniqueness` | Yes | Yes | Yes | No | No | No (1-of-1) | Yes | No | `client.createEscrow({ uniqueRef: true, ... })` |
| `create_split_escrow` | Yes | Yes | Yes | No | No | No (1-of-1) | No | No | Contract invocation |
| `create_escrows` | No | No | No | No | No | No (1-of-1) | No | Yes (up to 12) | `client.createEscrows(...)` |
| `create_streamed_escrow` | No | No | No | No | No | No (1-of-1) | No | No | `client.createStreamedEscrow(...)` |
| `create_pooled_escrow` | No | No | No | No | No | No (1-of-1) | No | No | `client.createPooledEscrow(...)` |
| `create_pooled_release_deadline` | No | No | No | No | No | No (1-of-1) | No | No | Contract invocation |

---

## 2. Unsupported / Incompatible Combinations & Workarounds

Some feature combinations cannot be combined in a single escrow creation call today:

1. **Payee Acceptance + Protocol Fee:**
   - *Constraint:* `create_escrow_with_acceptance` does not accept `fee_recipient` or `fee_bps`.
   - *Workaround:* If a protocol fee is required, use `create_escrow` without payee acceptance and enforce acceptance off-chain before invoking `release`, or structure fee settlement as a separate step.

2. **Payee Acceptance + Release Time (`release_not_before`):**
   - *Constraint:* Neither `create_escrow_release_time` nor `create_escrow_with_acceptance` support both options.
   - *Workaround:* Use `create_escrow_with_acceptance`, and have the off-chain releaser verify the current timestamp before signing and submitting `release`.

3. **Releaser Quorum (M-of-N) + Protocol Fee:**
   - *Constraint:* `create_escrow_with_releasers` does not take fee parameters.
   - *Workaround:* Collect protocol fees at deposit time upstream in the integrator service, or deduct fees from payer/payee through off-chain ledger arrangements.

4. **Batch Creation (`create_escrows`) + Advanced Options:**
   - *Constraint:* `CreateItem` only takes `(payee, token, amount, condition_ref, releaser, refund_after)`. Options such as `refund_to`, fees, acceptance, or release timestamps are not supported in batch items.
   - *Workaround:* Call individual creation methods (`createEscrow`) concurrently using `Promise.all` or sequential transactions if custom refund destinations or fees are needed.

5. **Pooled Escrows + Fees / Custom Refund Destination:**
   - *Constraint:* Pooled escrows aggregate contributions from multiple payers. Refunds are strictly pro-rata to individual contributors; fees and custom `refund_to` are not supported.

---

## 3. SDK Parameter Mapping Reference

When using `@docforum/escrow-sdk`, the client routes internally to the appropriate entry point:

- **`client.createEscrow(params: CreateEscrowParams)`**:
  - Automatically selects `create_escrow_with_acceptance` when `requiresAcceptance: true`.
  - Automatically selects `create_escrow_release_time` when `releaseNotBefore` is provided.
  - Automatically selects `create_escrow_with_uniqueness` when `uniqueRef: true`.
  - Otherwise uses `create_escrow`.
  - *Validation:* Throws an error client-side if incompatible combinations (such as `requiresAcceptance` combined with `releaseNotBefore` or `notifyPayee`) are passed.
- **`client.createQuorumEscrow(params: CreateQuorumEscrowParams)`**:
  - Invokes `create_escrow_with_releasers`.
- **`client.createEscrows(items: BatchCreateItem[])`**:
  - Invokes `create_escrows`.
- **`client.createStreamedEscrow(params: CreateStreamedEscrowParams)`**:
  - Invokes `create_streamed_escrow`.
