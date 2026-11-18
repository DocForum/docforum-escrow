# ADR 0010: Payee-initiated voluntary refund

- **Status:** Accepted
- **Date:** 2026-10-17
- **Issue:** [#40](https://github.com/DocForum/docforum-escrow/issues/40)

## Context

A payee may decide that it will not or cannot fulfill the agreement. Before
this change, a funded escrow could be refunded only by its releaser or by
any caller after the optional `refund_after` deadline. The payee had no way
to return the funds early, even when both parties wanted to cancel.

The contract stores exactly one payee and supports all-or-nothing release
and refund. It has no split-payee or partial milestone accounting.

## Decision

The stored payee may call `refund` while the escrow is `Funded`. The payee
must authorize the invocation through `require_auth`. As with every refund,
the contract sends the entire escrow amount only to the payer stored when
the escrow was created. The payee cannot choose a refund destination or
release funds to itself through this path.

A payee-initiated refund emits `payee_refunded`, including the escrow ID,
payer, payee, and amount. Releaser-initiated and deadline-based refunds
retain their existing behavior and do not emit this event.

## Consequences and limits

The payee can voluntarily return a funded escrow without waiting for the
deadline or asking the releaser to act. The existing funded-state check
continues to prevent a second settlement. Multi-payee consent is not
applicable to the current single-payee data model. If split payees or
partial releases are introduced later, the design must define consent and
ensure refunds return only the unpaid remainder.
