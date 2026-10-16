# ADR 0005: Optional `refund_to` — refunds can go somewhere other than the funder

Status: Accepted (2026-10-16)

## Context

Today the `payer` both funds an escrow and receives every refund. Sponsors,
employers and grant programmes fund on behalf of someone else, and for them
*where a refund goes* is the whole point: back to the sponsor whose money it
was, or onward to the beneficiary the sponsor was paying? With one `payer`
role integrators either work around it off-chain or get the wrong answer.

Issue #28 asks two questions before any code:

1. Is a separate refund destination compatible with **invariant I1**
   (threat model §1: funds only ever leave an escrow to destinations that
   were fixed at creation — the `payee` on release, the refund recipient on
   refund — never chosen at payout)?
2. Who must authorise it?

Constraints:

- **I1** and its reviewer test: destinations fixed at creation, never chosen
  at payout.
- **ADR 0001**: the contract enforces WHO, never WHY — it must not learn what
  a "sponsor" or "beneficiary" is.
- **ADR 0002 / 0004**: no admin or privileged role; any new path must fail in
  a safe direction.
- **Hard rule 2**: contract logic changes ship with tests.

## Decision

### Compatible with I1: yes, as long as it is stored at creation

I1 never said the refund destination is the *funder*. It says the
destination is read from storage, not from call arguments. Today that
stored value happens to be `payer`. Adding a second stored address,
`refund_to`, written once in `create_escrow` and read (never supplied) by
every refund path, preserves exactly the property I1 protects:

- no refund caller — releaser, a stranger after `refund_after`, the funder
  itself — passes or influences a destination;
- no function mutates `refund_to` after creation (there is no setter, same
  as `payee` and `releaser`);
- a full compromise of the `releaser` key still only picks the outcome
  (release vs refund), never an address.

I1's wording is updated from "`payer` (on refund)" to "the escrow's stored
`refund_to` (on refund), which is `payer` unless set otherwise at creation".

### Who must authorise: the funder, in the same signature that moves the money

`create_escrow` already requires `payer.require_auth()`, and Soroban's
authorisation covers the full invocation **including all arguments**. So
`refund_to` is covered by the funder's existing signature: the funder
cannot be made to fund an escrow whose refund destination they did not
sign for. No additional signature is needed from `refund_to` — it only ever
*receives*, never pays or acts — and requiring one would make sponsorship
impossible for beneficiaries who are not online or not on-chain yet.

### Surface

- `create_escrow(..., refund_after, refund_to: Option<Address>)`.
  `None` ⇒ `refund_to = payer`, so behaviour with the argument omitted is
  identical to before (an explicit `Some(payer)` is equivalent).
- `EscrowData` gains `refund_to: Address` (always populated — the resolved
  value), readable through `get_escrow`, so payees can see who a reversal
  would pay (threat model T8).
- Every refund path transfers to `data.refund_to`: the releaser's `refund`
  and the anyone-after-deadline timeout refund (ADR 0004) are the same
  function and the same line. There is currently **no payee-initiated
  refund** in this contract; any such path added later must also use
  `refund_to` and carry its own test.
- `release` is unchanged — it still pays the stored `payee`.
- New error `InvalidRefundTo = 7`: `refund_to` may not be the contract's own
  address (funds sent there could never move again). Checked before any
  funds move. The existing `BalanceMismatch = 6` is untouched.

### Naming: `payer` stays the funder

Renaming `payer` to `funder` would churn the live ABI for no gain. `payer`
remains the account that authorises and funds; its doc comment says so.

### Not restricted: `refund_to == payee`, or an arbitrary third party

The funder is spending its own money and chose these addresses under its
own signature, so the contract does not second-guess them. Consequence worth
knowing: with `refund_to == payee`, a "refund" pays the payee, which makes
the releaser's choice between release and refund moot and lets anyone push
the funds to the payee after the deadline. That is a funder decision the
payee can verify via `get_escrow`; it adds no way to reach a third address
the funder did not name (I1).

## Consequences

- **Funders:** `refund_to` is permanent. A mistyped or uncontrolled address
  means refunds go there. For a Stellar asset the destination must also be
  able to hold the token (e.g. an existing trustline): if the transfer
  fails, the refund fails and the escrow stays `Funded`; there is no
  fallback destination (adding one would be a post-creation choice, which I1
  forbids). Funders should verify `refund_to` can receive the token before
  creating the escrow. The default is the funder, who by definition can.
- **Payees:** `get_escrow().refund_to` says who a reversal pays; check it
  alongside `releaser` and `refund_after` (T8).
- **Sponsors, concretely:** a sponsor wanting money back on failure passes
  nothing (default) or its own address; a grant programme wanting unspent
  funds to go to the beneficiary passes the beneficiary.
- **Breaking change** to the contract ABI (`create_escrow` gains a
  parameter, `EscrowData` gains a field) and so to the SDK:
  `@docforum/escrow-sdk` 0.3.0 → 0.4.0 (0.x-minor-for-breaking, as in
  0.2.0 → 0.3.0). SDK callers who omit `refundTo` keep today's behaviour.
  The live testnet deployment predates this and needs a redeploy.

## Alternatives considered

- **Rename/split roles: `funder` and `payer`, both stored.** Rejected: same
  semantics as `refund_to`, but renames a live field.
- **A setter so the funder can change `refund_to` later.** Rejected: it is a
  destination chosen after creation, which is exactly what I1 and the
  reviewer's check rule out, and would let a compromised funder key
  redirect a payee-relevant outcome.
- **Require the refund recipient to co-sign creation.** Rejected: recipients
  only receive; it blocks sponsorship of parties who can't sign yet and
  adds no safety (the funder, not the recipient, bears the risk of a wrong
  address).
- **Fallback to `payer` if the transfer to `refund_to` fails.** Rejected:
  the fallback would be chosen at payout, and a failing transfer inside
  Soroban aborts the whole invocation anyway.
