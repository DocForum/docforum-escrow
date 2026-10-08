# ADR 0004: Optional `refund_after` deadline — after it passes, anyone may refund to `payer`

Status: Accepted (2026-10-08)

## Context

`docs/threat-model.md` T2 (rated High): if an escrow's `releaser` key is
lost — or was set to an address that can never sign, which
`create_escrow` does not validate beyond its type — every `Funded`
escrow that identity controls is **locked forever**. There is no
timeout, no fallback refund path, no admin and no upgrade (the deployed
WASM is immutable). Funds stay in the contract address permanently.

Threat model §6 puts the choice plainly: "Decide on a timeout refund
path, or record why not in an ADR (T2)." Issue #11 asks for this ADR
first, and for the implementation only if the ADR says yes.

Constraints any decision here has to respect:

- **ADR 0002**: no contract-level admin, no privileged identity —
  per-escrow control, no single point of failure.
- **ADR 0001 / hard rule 1**: the contract enforces WHO, never WHY, and
  stays domain-blind. A timeout must not require the contract to
  interpret `condition_ref` or otherwise guess when fulfilment happened.
- **Invariant I1** (threat model §1): funds only ever leave an escrow to
  that escrow's stored `payee` (release) or `payer` (refund). No third
  destination may be introduced by whatever we add.
- **Hard rule 2**: contract logic change ⇒ tests in the same PR.

## Options considered

### 1. Optional `refund_after` at creation; after it passes, anyone may refund to `payer` (the threat model's candidate)

`create_escrow` takes an optional deadline (unix timestamp). Once the
ledger's close time reaches it, `refund` opens to **any** caller —
including the payer themselves, or a stranger — but still only to the
stored `payer`, and still only while the escrow is `Funded`.

- Removes the permanent lock without inventing a privileged role: the
  trigger is a clock, not an identity.
- The failure direction is safe: the worst an adversary can do with the
  new path is hand the payer their own money back. It cannot be used to
  divert funds (I1 holds — the destination is still read from storage).
- Optional, so escrows that don't want a deadline are unaffected:
  `refund_after: None` behaves exactly as today.

### 2. A privileged unlock role (contract-level admin or governance key)

A deployer-set identity authorised to refund (or force-unlock) any
escrow after some condition.

- Directly contradicts ADR 0002, which rejected a contract-level admin
  precisely because one identity's compromise or unavailability affects
  every escrow the contract will ever hold. A lost admin key reintroduces
  T2 at contract scope instead of escrow scope; a stolen one adds a new
  way to end escrows early.
- Also violates the spirit of ADR 0001: someone would have to decide
  *when* an unlock is warranted, and that decision has nowhere honest to
  live but the contract.

### 3. Releaser rotation (a setter to change `releaser` on an existing escrow)

Would recover from key loss without a timeout, but it changes the
trusted party **after** creation: the payee already checked (or was
handed) a specific `releaser`, and rotation lets a compromised key
appoint a successor — or the payer appoint themselves. It fixes T2 by
weakening the property the payee relied on. Rejected.

### 4. Do nothing, record the lock as accepted risk

Cheapest, and honest if the operational mitigations (key backup,
multisig releaser as in T1) were enough. They are not sufficient on
their own: `create_escrow` accepts any `releaser` address, including
ones that can never sign, and a consumer typo is enough to strand funds.
For a contract whose whole job is holding other people's money, "locked
forever, by design, on a mistake anyone can make" is not an acceptable
residual risk. Rejected.

## Decision

Option 1.

1. `create_escrow` gains a final parameter
   `refund_after: Option<u64>` — a unix timestamp in seconds. `None`
   means no timeout (behaviour identical to today). `Some(t)` must be
   **strictly in the future** at creation; otherwise creation fails with
   a new `Error::InvalidRefundAfter` (a deadline that has already passed
   would let anyone refund the escrow before the releaser could ever act
   on it).
2. `refund` keeps its existing rule (`caller == releaser`, status
   `Funded`) **and** adds one relaxation: when `refund_after` is set and
   `env.ledger().timestamp() >= refund_after`, **any** caller may call
   it. The destination is unchanged — always the stored `payer`.
3. `release` is deliberately **not** gated by the timeout. The releaser
   keeps the right to release after the deadline; whoever submits first
   wins, and the loser fails with `NotFunded` because the status flips in
   the same transaction. The timeout therefore never pre-empts a
   legitimately pending escrow before its deadline, and after the
   deadline it is a race the releaser is still eligible to win — not a
   lock-out.
4. A new read-only `get_escrow(escrow_id)` returns the stored
   `EscrowData`, so `refund_after` is actually inspectable on-chain by
   payees and integrators (a write-only deadline would be unenforceable
   from anyone's point of view).

## What the timeout means for payees (threat model T8)

T8 already says a `Funded` status means "the funds are locked under the
stored `releaser`'s control", not "the funds are committed to me". This
ADR makes that conditional in one specific, bounded way:

- **With `refund_after`, the commitment expires.** After the deadline the
  funds can go back to the payer without the releaser's cooperation, so
  a payee must treat such an escrow as *time-bounded*, not final.
- **Payees should read it before relying on an escrow** — via
  `get_escrow`. The checks stay the same in kind as the ones T8 already
  prescribes: look at who the `releaser` is, and now also at whether and
  when `refund_after` falls inside the window the payee actually needs.
- **The direction of the new risk is griefing, not theft.** The timeout
  path can only return funds to the payer; it cannot pay a third party.
  So a payee's realistic exposure is that payment is delayed past the
  deadline and then reversed — never redirected. The releaser can still
  release after the deadline, so an honest consumer that merely lost
  track of time can still pay.
- **A payee that needs certainty should require an escrow with no
  `refund_after`** (or one comfortably beyond the longest plausible
  fulfilment window) from a `releaser` it trusts. That is exactly the
  deal as it exists today; nothing here makes the no-timeout case worse.
- Nothing about this is domain-specific: no interpretation of
  `condition_ref`, no judgement about whether the work was done — the
  contract only compares a clock to a stored number (ADR 0001 intact).

## Consequences

- **`create_escrow`'s signature changed** — a breaking change, the
  second parameter added since Phase E1 (`releaser` by ADR 0002,
  `refund_after` here). The contract must be redeployed; the
  previous testnet deployment is superseded and kept as history in
  `docs/testnet-deployments.md`.
- **Storage layout changed** (`EscrowData` gains `refund_after`), so the
  old contract id is not signature- or layout-compatible with the new
  source. No migration of live escrows is needed or possible — the old
  deployment keeps holding whatever it holds, as it does today.
- **SDK**: bindings regenerated from the new WASM, `@docforum/escrow-sdk`
  bumped **0.2.0 → 0.3.0** (breaking change under hard rule 3; in 0.x a
  breaking change bumps the minor, same as 0.1.0 → 0.2.0 for the
  `txHash` change).
- **Migration for `docforum-core`** (the only known consumer):
  1. Rebuild/redeploy the contract and take the new contract id.
  2. Publish the new SDK tarball per ADR 0003 (tag `sdk-v0.3.0`) and
     upgrade the dependency to it — the 0.3.0 tarball is the follow-up
     step, not part of this change.
  3. Pass `refundAfter` in every `createEscrow` call — `undefined` keeps
     today's semantics; a real deadline must be a future unix timestamp
     in seconds, sized to the longest fulfilment window the payments
     module can honour.
  4. Optionally read `getEscrow(...)` to surface `refundAfter` to
     whoever relies on the escrow.
  Old escrows (created under the previous signature) keep their old
  contract id and their existing `releaser`-only refund rule.
- **New error code**: `Error::InvalidRefundAfter = 5`.
- A post-deadline race between `release` and a timeout refund is
  inherent and accepted: it resolves in ledger order, with exactly one
  winner (I3 still holds).
- Threat model T2's contract-change mitigation is implemented; §6's
  "timeout refund path" item can be checked off. The operational half of
  T2 (key backup / multisig releaser) still stands — this removes the
  permanent-lock failure mode, it does not make a lost key harmless.
