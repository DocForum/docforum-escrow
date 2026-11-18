# ADR 0010: Optional protocol fee, fixed at creation and taken at release

Status: Accepted (2026-10-20)

## Context

Integrators that run a platform on top of this escrow usually take a fee.
Without contract support the realistic options are:

1. Release **everything** to the payee and invoice them off-chain — the
   platform extends credit to the payee, and collection is trust, not code.
2. Route payouts through the platform first — custody again, exactly the
   concentration of trust this contract exists to remove (ADR 0002's whole
   point was that no single identity sits in the middle).

An on-chain fee fixed at creation has a notable transparency property:
**both** the payer and the payee can read the exact fee (recipient + bps)
from `get_escrow` *before* locking funds into the escrow, so there is no
post-hoc surprise about how much actually lands. This is issue #30's
motivating argument, and it is why the fee must be a `create_escrow`
parameter rather than anything that can be set or changed later.

Constraints any decision here has to respect:

- **ADR 0001 / hard rule 1**: the contract stays domain-blind. A fee is a
  money mechanic, not domain logic, so it is compatible — but the
  implementation must not start interpreting who "deserves" a fee.
- **Invariant I1** (threat model §1): funds leave an escrow only to that
  escrow's stored `payee` or `payer`. A fee introduces the first sanctioned
  third destination, so it has to be bound by an explicit invariant of its
  own (below) rather than weakening I1 silently.
- **ADR 0002**: no privileged role. The fee recipient is fixed per escrow
  at creation, not held in any contract-level admin.
- **Hard rule 2**: contract logic change ⇒ tests in the same PR.

## Decisions

### 1. One optional fee parameter pair at creation — recipient and bps always paired

`create_escrow` gains two final parameters, `fee_recipient: Option<Address>`
and `fee_bps: Option<u32>`, accepted together or not at all: a
recipient without a rate, or a rate without a recipient, is rejected at
creation with `Error::InvalidFee`. `create_escrow_release_time` gains the
same pair (the SDK routes its `releaseNotBefore` path through it); the
acceptance and M-of-N creation entry points do not take a fee and record
none. Fee-free escrows are byte-for-byte the previous behaviour.

*Revision note (2026-10-20, same day as initial acceptance, implementation
feedback):* the decision was originally written as one optional
`fee: Option<Fee>` struct parameter, which would make the mismatched
combinations impossible by construction rather than a runtime rule. That
mechanism does not survive contact with soroban-sdk 27: `#[contracttype]`
generates only a *fallible* `TryFrom<struct> for ScVal`, and the XDR
blanket `impl<T: Into<ScVal>> From<&Option<T>> for ScVal` reachable from
the generated testutils conversions needs an *infallible* `Into<ScVal>`
for the inner type — so any custom-struct field/parameter inside an
`Option` fails to compile once the testutils feature is on (exactly where
the deadline and fee escrow data types live). The two-`Option` parameter
pair, with the both-or-neither rule enforced at creation, is the same
semantics spelled with primitive-optional types that do convert. The
rule is still tested exactly once (`create_escrow_rejects_a_fee_recipient
_without_a_rate_and_vice_versa`), and stored escrows can never read back
a half-pair because creation is the only writer.

### 2. `bps` is capped at 1000 (10%), `bps = 0` allowed

Basis points: 10 000 bps = 100 %. The cap is a contract constant
(`MAX_FEE_BPS = 1_000`), enforced at creation with the new
`Error::InvalidFee = 35` (the next unused code on top of the current
surface, after batch creation's `BatchTooLarge = 25` and the pooled-escrow
codes 26–34 from docs/adr/0011; every existing code keeps its number because
consumers map codes, not names — the 2026-10-08 `#17`/`#18` merge incident
is the standing warning). This change originally proposed 25 and was
renumbered when it was merged with those features, rather than moving any
code already on `main`.

`bps = 0` with a set recipient is accepted, not rejected: it lets an
integrator declare a fee slot that currently takes nothing (e.g. a
promotional period), which is more readable than juggling `None`ed and
`Some`ed escrows. The behaviour is also harmless: a zero fee simply
transfers nothing at release. What *is* rejected: `bps > 1000`, and a
`fee_recipient` equal to the escrow contract's own address (see 5).

### 3. Rounding: fee floors, remainder goes to the payee

At release the fee is `amount × bps ÷ 10_000` using integer division —
i.e. **rounded down (truncated)**, and the fractional remainder stays with
the payee. Rationale:

- Truncation is the only tie-breaking rule that needs no arbitrary
  choice of beneficiary: the *payee* is the escrowed party and the
  recipient's take can only be ≤ their nominal bps share, never above.
- It makes the accounting exactly closed: `fee + payee_payout == amount`
  always, with no dust lost anywhere and no rounding-dependent imbalance
  between two transfers.
- An alternative "round half up" would pay the recipient up to one
  token-unit more than their bps entitle them to, which needs a reason;
  none exists.

Because `bps ≤ 1000`, `amount × bps` cannot overflow `i128` for any
amount a token contract can hold — but the multiplication is still
`checked_mul`-guarded, and overflow is rejected at creation as
`InvalidFee` (fail-closed: a recoverable, typed error the caller sees,
not a panic). A `top_up` raises the stored `amount`, so it raises the
bps fee with it; the fee math for the larger amount is re-checked before
the top-up transfer and rejected with `InvalidFee` rather than failing
the later release.

Consequence, accepted and tested: for tiny amounts the fee can floor to
zero (e.g. a 305-unit escrow at 10 % pays a fee of 30, not 30.5 — and a
9-unit escrow at 10 % pays a fee of 0, the payee getting everything). An
integrator that needs a minimum take must enforce a minimum escrow
`amount` off-chain; the contract takes no position (ADR 0001).

### 4. The fee comes off the top — once, against the total `amount`

This contract pays out to a single payee today, but the point of fixing
this now is so the rule is settled before any split-payout feature lands.
Decision: the fee is computed **once against the whole stored `amount`**
at release, and per-payee shares would then be computed over the *net*
(`amount − fee`). Rejected alternative: computing and charging the bps per
payee, which would let a platform's take scale with escrow complexity and
complicate the sum invariant per payout; "off the top" keeps one fee, one
remainder, and one arithmetic rule to verify.

### 5. The fee recipient cannot be the escrow contract itself, any other address is allowed

A self-directed fee is the one combination that is pure misconfiguration:
funds sent to the contract's own address would sit outside any escrow, be
untracked by the escrow's accounting, and be unrecoverable by any code
path this contract offers (nothing refunds the contract "to itself").
Rejected at creation with `InvalidFee`.

Everything else is allowed and stays the integrator's choice, declared
on-chain and inspectable: `recipient == payee` (the "platform fee" going
to the only counterparty — legitimate, e.g. when the platform *is* the
payee), `recipient == payer` (a payer configuring a fee payable to themselves —
pointless, but it is their configuration to make and it cannot harm
anyone else), or any third address (the normal case: the
platform account). The contract enforces that the fee *is what was
declared to everyone before funding* — not that the business arrangement
is sensible (ADR 0001).

### 6. Refunds never take the fee

`refund` — releaser-initiated or after `refund_after` — returns the full
stored `amount` to the payer, exactly as it did before this ADR. A fee is
compensation for *facilitating a successful outcome*; a failed or
timed-out deal returning the payer's money is not that event, and taking
a cut of a refund would be indistinguishable from charging the payer for
the payee's non-performance. Consequence, accepted: the fee recipient
keeps nothing when the deal falls through; the platform's revenue exists
only on the release path.

### 7. At release the fee transfer happens first, then the payee remainder

Two transfers, fee first: if either transfer fails the whole invocation
reverts atomically (Soroban), so the ordering cannot strand one side
while paying the other. Fee-first is simply the reading that matches
decision 4 ("off the top") in the tx's event stream, which is where
integrators will look.

## Invariant added (companion to I1)

**I7 (fee conservation):** exactly once per escrow's lifetime, at release,
and only if a fee was declared at that same escrow's creation: the fee
transfer's amount is `⌊amount × fee_bps ÷ 10 000⌋` (≤ 10 % of `amount`),
its destination is exactly the `fee_recipient` fixed at creation, and
`fee + payee_payout == amount` exactly. No fee exists on the refund path,
and no fee can be introduced, changed, or removed after creation.

## Consequences

- **`create_escrow`'s signature changed** — a breaking change. Every
  earlier parameter keeps its position and the fee pair is appended after
  `refund_to`, so only callers that construct the call by position (the
  generated bindings and Rust clients) need updating. The contract must
  be redeployed; the current testnet deployment predates the fee and keeps
  its record as history in `docs/testnet-deployments.md`.
- **Storage layout changed** (`EscrowData` gains `fee_recipient` and
  `fee_bps`, as optional fields never stored half-set), so
  the old contract id is not layout-compatible with the new source. No
  migration of live escrows is needed or possible — old deployments keep
  settling their escrows fee-free, exactly as they always did.
- **SDK**: bindings regenerated from the new WASM (never hand-edited),
  `@docforum/escrow-sdk` gets a minor changeset (**0.6.0 → 0.7.0** on the
  next release; breaking under hard rule 3, where 0.x bumps the minor).
  `createEscrow` gains optional `feeRecipient`/`feeBps` parameters and
  validates the pair client-side (both-or-neither, 0..=1 000);
  `getEscrow()` surfaces what was declared — payer and payee alike can
  read the fee before relying on the escrow (the issue's motivating
  requirement).
- **Event payload**: the `ESCROW` state snapshot appends the fee as one
  nested `(fee_recipient, fee_bps)` pair. It is nested because
  soroban-sdk supports event data tuples of at most 13 values and the
  snapshot already had 12; keeping the pair atomic also mirrors storage.
- **Migration for `docforum-core`**: 1. omit `feeRecipient`/`feeBps` for
  fee-free escrows (semantics unchanged from 0.6.x); 2. pass
  `feeRecipient: <address>, feeBps: <0..1000>` where a platform fee
  applies, with the cap enforced on-chain; 3. read
  `getEscrow(...).feeRecipient` / `.feeBps` where the UI should show the
  platform's cut.
- **New error code**: `Error::InvalidFee = 35`.
- The redeployment is testnet-only and needs the Phase E4 security
  review *before* any mainnet use (hard rule 4 unchanged).
