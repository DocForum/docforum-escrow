# ADR 0011: Emergency pause — one custodian address, blocks new deposits only

Status: Accepted (2026-10-20)

## Context

Issue #35 (Phase E5): if a bug is found after mainnet, the only defence
today is telling integrators to stop calling the contract. Nothing on-chain
can slow down a live exploit, and nothing should give anyone the power to
touch funds that are already escrowed.

The useful split is between the **inbound** and **outbound** halves of the
contract:

- **Inbound** (`create_escrow`): new money enters the contract's shared
  balance. Every new escrow is new exposure to whatever bug exists.
- **Outbound** (`release`, `refund`, including the `refund_after` timeout
  path from ADR 0004): existing money leaves to the escrow's stored
  `payee` or `payer`. Stopping these protects nobody — it is exactly the
  permanent-lock failure mode the contract has been engineered to avoid
  (ADR 0004, threat model T2).

So the narrow, defensible control is a switch that stops new escrows and
nothing else. Constraints any decision here has to respect:

- **Invariant I1** (threat model §1): funds only ever leave an escrow to
  that escrow's stored `payee` (release) or `payer` (refund). A pause must
  not create a new destination, or a new way to move funds at all.
- **ADR 0002** rejected a contract-level admin for `release`/`refund`
  precisely because one identity's compromise or loss would affect every
  escrow the contract holds. A pause custodian is a contract-level role,
  so it has to be *strictly less* powerful than that rejected admin:
  it may only refuse **new** business. It must have no authority over any
  existing escrow, no ability to end one early, no ability to redirect
  anything, and no upgrade power (the deployed WASM stays immutable).
- **ADR 0001 / hard rule 1**: the contract enforces WHO, never WHY, and
  stays domain-blind. A pause is a flag an operator flips; the contract
  does not decide *why* it was flipped, and the flag is not derived from
  `condition_ref` or any domain state.
- **Hard rule 2**: contract logic change ⇒ tests in the same PR.
- **Hard rule 4**: testnet only until the Phase E4 review is done. This
  ADR does not change that.

## Options considered

### 1. Custodian address set at deploy, may pause and unpause — **chosen**

`__constructor(allowed_tokens, pause_admin)` stores one address at
deployment (the token allowlist keeps its existing position, and the
custodian is appended after it). `pause(caller)` and `unpause(caller)`
require `caller.require_auth()` and `caller == pause_admin`; every deposit
entry point returns `Paused` while the flag is set. Nothing else reads the
flag.

- The role is real but bounded: it can only make `create_escrow` fail.
  It cannot release, refund, rotate a `releaser`, change stored escrow
  data, extend/deny a refund path, or upgrade the contract.
- Worst case of a compromised custodian is **liveness, not solvency**:
  no new escrows on this contract id until the address unpauses. Every
  already-funded escrow still pays out exactly as before.
- One address is the smallest possible surface, and `require_auth` on an
  account address honours that account's own signer thresholds — so
  "multisig custodian", the deployment we want for mainnet, needs **no
  contract change**, only passing a Stellar multisig account address
  (2-of-3, say) at deploy time. Same pattern ADR 0002 and threat model T1
  already recommend for the releaser.

### 2. Anyone may pause, anyone may unpause

A permissionless circuit breaker: any observer can stop new deposits the
moment they see something wrong.

- Opens a trivially cheap griefing/DoS: a stranger pauses the contract
  forever, re-pausing every time someone unpauses. Since unpause is also
  permissionless, there is no way to settle the race in the honest party's
  favour on-chain.
- The *detection* half of "anyone can react" is better served off-chain:
  integrators can stop calling on their own, which is exactly what they do
  today. Rejected.

### 3. Time-bounded pause (auto-expires unless re-paused)

A pause that lapses after e.g. 24h unless the custodian re-pauses, so even
a malicious custodian can only deny new business briefly.

- Genuinely nicer against a malicious custodian, but it creates the worse
  operational failure: the pause **silently expires** while an operator
  believes new deposits are still blocked. During an active incident that
  is the last thing anyone should have to monitor.
- It also does not remove the powers that matter: the custodian could
  still re-pause from a bot, and the thing it protects (new deposits) was
  never the funds-at-risk surface. Rejected as complexity without a real
  safety gain — the residual risk is documented under T12 instead.

### 4. Token allowlist / deploy-time limits only

Restrict *which* tokens can be escrowed rather than whether new escrows may
be created. Useful, and tracked separately (the token allowlist issue), but
it cannot respond to a bug in this contract's own logic — the failure mode
issue #35 is about. Rejected as a substitute; complementary at best.

### 5. Do nothing, keep "tell integrators to stop"

The status quo. It leaves no on-chain lever and relies on every integrator
noticing and complying within the same window. For a contract whose whole
job is holding other people's money, one narrow, fund-free safety valve is
worth the extra trusted address. Rejected.

## Decision

Option 1.

1. **Deploy-time configuration via a constructor.**
   `__constructor(env: Env, allowed_tokens: Vec<Address>, pause_admin:
   Address)` stores the custodian in instance storage (`DataKey::PauseAdmin`)
   and leaves the pause flag unset (= not paused); the token allowlist keeps
   its original first position. No auth is required in the constructor: it
   runs as part of deployment, before any caller exists, and the address is
   immutable afterwards (no setter).
2. **Pause/unpause by the custodian only.**
   `pause(caller)` / `unpause(caller)` call `caller.require_auth()` and
   compare against the stored custodian, returning `Unauthorized`
   otherwise. They are *not* idempotent: pausing an already-paused contract
   returns `AlreadyPaused`, unpausing a running one returns `NotPaused`, so
   an event never claims a transition that didn't happen.
3. **Scope: new deposits only.** Every creation entry point funnels through
   `create_escrow_inner`, which checks the flag first and returns the new
   `Error::Paused` (provisional code 3500) without pulling funds, without
   consuming an escrow id, and without writing an escrow. `top_up` — a deposit path added after
   this ADR was first written — applies the same check before its transfer,
   exactly as the ADR originally required of any future deposit path.
   Pooled escrows (docs/adr/0011-pooled-escrow-funding.md) are gated the
   same way: `create_pooled_escrow` and `contribute` return `Paused` while
   the flag is set, and pull-based `claim_refund` never reads it, so a
   failed pooled round can always be refunded.
   `release`, `refund` (both the releaser path and the ADR 0004 timeout
   path), `get_status`, `get_escrow` and `is_paused` never read the flag.
4. **How to unpause.** The same custodian calls `unpause`. No timelock on
   either direction: the entire point of the switch is a fast response to a
   live bug, and delaying unpause would delay recovery while delaying pause
   would defeat the control. Neither call affects any escrow, so neither
   needs a governance delay to be safe. There is no auto-unpause (see
   option 3) and no second role.
5. **Observability.** `pause` and `unpause` emit `Paused` / `Unpaused`
   contract events carrying the custodian address, so integrators and
   monitoring can detect the transition without polling. The lifecycle
   `ESCROW` snapshot events are separate and unmodified by the pause
   (threat model T7).
6. **Read path.** `is_paused()` (bool) and `get_pause_admin()`
   (`Option<Address>`) are read-only, so an integrator can check state
   before building a transaction and can verify who the custodian is
   without trusting documentation.

## Why not gate `refund`/`release` "for safety"

A pause that can stop outbound transfers is strictly worse than no pause:
it converts a *possible* loss into a *certain* lock for every open escrow,
and it hands the custodian exactly the power ADR 0002 rejected (the ability
to decide whether someone's money ever moves). The whole value of this
control is that it is boring: paused means "no new business", never
"your money is stuck". The review criterion for this change is therefore
the negative one — *every* outbound path must be provably unaffected, and
`contracts/escrow/tests/pause.rs` asserts that directly while paused:
release, releaser refund, timeout refund by a stranger, and release after
the deadline.

## Consequences

- **The deposit entry points' signatures are unchanged**, but the
  contract's constructor gains a `pause_admin` argument, so **deployment
  changes**: every deployment must now supply both `allowed_tokens` and
  `pause_admin`. The existing testnet deployments predate it and are kept
  as history in `docs/testnet-deployments.md`; a redeploy is needed for the
  pause to exist on-chain at all. There is no constructor-less deploy path
  and no way to add a custodian to an already-deployed instance (the WASM
  is immutable) — that is deliberate: no post-hoc admin can appear.
- **Storage layout**: `EscrowData` is unchanged; two new instance-storage
  keys (`PauseAdmin`, `Paused`) are added. Existing escrow entries are
  unaffected — and there is no migration to worry about, because a
  redeploy is a new contract id by definition.
- **New error codes**: `Paused`, `AlreadyPaused`, `NotPaused`, added with
  the provisional codes 3500–3502 (issue #35 × 100 + n) described in
  `contract-changes.d/README.md`; the maintainer fold assigns the final
  numbers. Every existing code keeps its number, because consumers map
  codes, not names. They were originally reserved as 26–28, but batch
  settlement (`BatchTooLarge = 25`), pooled escrows (`NotPooled` through
  `InvalidFundingDeadline`, 26–34) and the protocol fee / outbound-transfer
  codes (`InvalidFee = 35`, `Undeliverable = 36`) landed on `main` first, so
  the pause codes go in after them.
- **New public functions**: `pause`, `unpause`, `is_paused`,
  `get_pause_admin`, plus the constructor. Additive but a real surface
  change: SDK bindings must be regenerated and the SDK minor-bumped by
  changeset (hard rule 3 — `0.6.0 → 0.7.0` on release), with
  `pause`/`unpause`/`isPaused`/`getPauseAdmin` wrapped for operators.
- **Trust model grows by one address** (threat model §2, new T12). It is
  the first contract-level role in this design; the ADR's justification is
  that its only power is to refuse new deposits. A consumer that cannot
  accept even that should not use this contract id — and payees should know
  that a pause does not change the terms of an existing escrow.
- **Coordination**: a contract has exactly one `__constructor`, so the
  token allowlist that landed separately is merged into the same one
  (`__constructor(allowed_tokens, pause_admin)`) rather than stacked. Any
  future deploy-time setting belongs there too.
- **Not solved here**: pausing does not help if a bug affects outbound
  paths, and it does not stop losses already in flight. It limits *new*
  exposure; the Phase E4 review and T5/T6 mitigations are still the things
  that reduce the chance of needing it.
