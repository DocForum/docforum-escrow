# Threat model — `docforum_escrow` contract + `@docforum/escrow-sdk`

Status: **Draft, self-written. Not a review.** Part of issue #6 (Phase E4).
Written by the contract's implementer, so per issue #6 it does **not**
satisfy the "external or community review" half of E4. Its job is to give
an independent reviewer a map of where to look and what the author
already believes is weak.

Scope: contract source at commit `5a455fb` (`contracts/escrow/src/lib.rs`),
the TypeScript SDK (`sdk/src/index.ts`), and the one known consumer
pattern (custodial, as `docforum-core` uses it today). The live testnet
deployment is listed in `docs/testnet-deployments.md`.
Updated 2026-10-07 for the issue #12 balance-delta check and
mock-token tests (§1 I4, T4, T5, §6).

*Updated 2026-10-08 for issue #11 (Phase E4): the timeout refund path
from T2's candidate list was decided in `docs/adr/0004` and implemented
defined in `docs/adr/0004` and implemented
(`refund_after` + `get_escrow`), so T2, T8 and the §6 checklist below now
reflect that. The scope commit above predates the change; everything else
in this document still describes the same design.*

*Updated 2026-10-09 for issue #37 (Phase E6): the T1 "multisig releaser"
mitigation is now backed by tested SDK helpers (`buildMultisigSetup`,
`dryRunMultisigSetup`, `verifyMultisig`) in `sdk/src/multisig.ts`. See T1
and §6 below for the new tooling and the lock-out rules it enforces.*

---

## 1. What the contract is supposed to guarantee

| # | Invariant | Enforced by |
|---|---|---|
| I1 | Funds only leave an escrow to that escrow's `payee` (on release) or `payer` (on refund). No other destination exists. | Destinations are read from storage, never from call arguments (`lib.rs:165`, `lib.rs:203`). The `refund_after` timeout path (issue #11, ADR-0004) adds a new *caller*Not a new destination. |
| I2 | Only the escrow's `releaser` can move funds out — or, once `refund_after` has passed, anyone at all, and then still only back to `payer`. | `caller.require_auth()` + `caller == data.releaser`, relaxed solely by the deadline check (`lib.rs:149`, `lib.rs:183`, `lib.rs:191`). |
| I3 | Each escrow pays out at most once. | `status == Funded` check before transfer, status written after — shared by release and both refund paths. |
| I4 | An escrow only exists, or grows, if the declared funds were actually transferred in. | `payer.require_auth()` + shared exact-balance-delta verification on create/top-up before storage is updated. |
| I5 | The contract never interprets `condition_ref`. | No code reads it after storage (ADR-0001). |

I1 is the most important property in this design. A full compromise of the
`releaser` key lets an attacker pick the **wrong outcome** (release when it
should refund, or the reverse). It does **not** let them redirect funds to
an address they control, unless they already control the `payee` or
`payer`. Neither does the timeout: it can only hand funds back to the
payer, so the worst case there is an escrow ending early, not funds going
somewhere new.

## 2. Assets and actors

**Assets:** tokens held by the contract address, summed across every
escrow; the integrity of each escrow's stored `EscrowData`.

| Actor | Can do | Trusted for |
|---|---|---|
| `payer` | Create escrows by funding them; chooses `payee`, `token`, `releaser` | Nothing after creation. Has no on-chain power to cancel. |
| `payee` | Receive funds | Nothing. Has **no on-chain power at all**, including no way to object to a refund. |
| `releaser` | `release` or `refund` its escrows, once | Choosing the correct outcome. This is the main trust assumption. |
| `token` contract | Executes transfers | Behaving like a standard SEP-41 token (see T5). |
| Anyone | Call `create_escrow` with their own funds, call `get_status`/`get_escrow`, and — on an escrow whose `refund_after` has passed — call `refund`, which can only send funds back to that escrow's `payer` | Nothing. |

There is **no admin, no upgrade function, and no pause.** The deployed
WASM is immutable. Nobody, including the deployer, can change an
escrow's data or move funds OUTSIDE `release`/`refund`.

## 3. Threats

Severity is the author's estimate for a mainnet deployment with real
value. **Reviewers should challenge these ratings.**

### T1 — `releaser` key leaked or stolen · **High**
- What an attacker can do: call `release` or `refund` on every
  still-`Funded` escrow whose `releaser` is that key, picking either
  outcome. Funds still only go to the stored `payee`/`payer` (I1).
- Actual loss: if the attacker also controls a `payee` address (for
  example a payee who colludes, or who got a fraudulent payee address
  recorded by the consumer), they can release that payee's escrows early
  and keep the funds. Otherwise the damage is wrong outcomes, not theft.
- Blast radius in practice: ADR-0002 picked per-escrow releasers to
  limit blast radius. But the custodial consumer (`docforum-core`,
  its ADR-0004) uses **one** `PLATFORM_RELEASER_SECRET` as the releaser of
  every escrow it creates. So today one leaked key affects every open
  escrow. The scoping benefit is available, but nobody uses it.
- Recovery: none on-chain. You can't rotate a `releaser` on
  an existing escrow (no setter exists). The only response is to race the
  attacker: use the same key to settle every open escrow correctly first.
- Mitigations to consider:
  - Make the `releaser` a Stellar multisig account (e.g. 2-of-3 signers).
    This works with no contract change, because `require_auth` on an
    account address checks that account's own signer thresholds.
    - [x] **Tooling (issue #37, Phase E6):** `sdk/src/multisig.ts`
      ships tested helpers for this setup:
      - `buildMultisigSetup({ account, signers, threshold })`
        returns the classic `setOptions` transaction(s) and
        rejects any lock-out configuration before building:
        the sum of remaining signer weights must remain at or
        above the high threshold, the master key must not be the
        only signer able to meet the threshold, and the master
        key weight change is always the last operation in the
        sequence.
      - `dryRunMultisigSetup` returns the resulting
        thresholds and signer weights without submitting anything,
        so operators can inspect the configuration first.
      - `verifyMultisig(account)` reads the on-chain thresholds and
        signer weights and reports whether they match the intended
        policy.
      - Testnet integration test covers 2-of-3 setup followed by an
        escrow release signed by two signers.
  - Keep the releaser key in a KMS/HSM, not as an environment variable.
  - In the consumer, rotate releaser keys periodically for *new*
    escrows, so a leak only reaches escrows from that key's period.

### T2 — `releaser` key lost · **High for escrows created without a timeout; mitigated (still worth planning for) with one**
- Effect (before issue #11): every `Funded` escrow with that
  `releaser` was **locked forever** — no timeout, no fallback refund path,
  no admin and no upgrade. Funds stayed in the contract address
  permanently.
- Effect (now): escrows created with a `refund_after` deadline can be
  recovered by **anyone** after it passes — always back to the `payer`
  (`docs/adr/0004`, implemented in issue #11). Escrows created *without*
  one (still the default, and what `docforum-core` passes today) keep the
  original behaviour: locked forever. The permanent-lock failure mode is
  removed from the contract, not from the call sites that decline to use
  it.
- Same applies to: a `releaser` that can never sign. For example, the
  contract's own address, or an address typed incorrectly at creation.
  `create_escrow` does not validate `releaser` beyond its type.
- Mitigations (contract changes need tests per hard rule 2):
  - [x] An optional `refund_after` timestamp set at creation. After it
    passes, anyone can trigger `refund` back to `payer` — **done**,
    decided in `docs/adr/0004` and implemented in issue #11 (tests in
    `tests/timeout_refund.rs`). Note the accepted consequence: after the
    deadline the escrow can end early *by anyone**, so a payee must read
    the deadline first (see T8).
  - [ ] Reject `releaser == current_contract_address()` and
    `payee == current_contract_address()` in `create_escrow`.
  - [ ] Operationally: back up the releaser key, or use a multisig as in
    T1, which also covers loss of one signer. Callers should pass a
    `refund_after` sized to their longest plausible fulfilment window.
    - [x] **Tooling (issue #37, Phase E6):** `sdk/src/multisig.ts`
      validates that the sum of remaining signer weights stays at or above
      the high threshold and that the master key weight change comes last,
      so a multisig releaser cannot be configured into a permanent
      lock-out.

### T3 — Double-spend / double payout · **Low (believed mitigated)**
- `release`/`refund` check `status == Funded` and fail with `NotFunded`
  otherwise. Tests cover double-release, release-after-refund, and
  refund-after-release (`tests/release_refund.rs`).
- Concurrent transactions: Soroban applies transactions in a ledger one
  after another. Both would touch the same storage key, so the second
  one sees the updated status and fails.
- Auth replay: Soroban auth entries carry a nonce and an expiration
  ledger, so a captured signed `release` can't be replayed on another
  escrow (the `escrow_id` is part of the signed invocation) or reused.
- Reviewer, please verify: that no path writes a status other than
  through these two functions, and that the status check can't be
  bypassed if the escrow entry is archived and then restored (see T6).

### T4 — Reentrancy · **Low (believed mitigated by the host), Informational**
- `release`/`refund` call the token's `transfer` **before** writing the
  new status (`lib.rs:128` then `lib.rs:131`). This is the classic
  "interaction before effect" order that causes reentrancy bugs on EVM.
- On Soroban, the host rejects a contract calling back into a contract
  that is already on the call stack. So a malicious `token` can't call
  `release` again mid-transfer. Also, if the transfer fails, the whole
  invocation rolls back, including the status write.
- Recommendation anyway: write `status` before calling `transfer`
  (checks-effects-interactions). It costs nothing. It also means safety
  doesn't depend on a host rule a reader might not know about.
- Update (issue #12): a test-only mock token that re-enters
  `release` from inside its `transfer` is rejected by the host with
  "Contract re-entry is not allowed" — an unrecoverable context error,
  so the entire release invocation aborts and nothing commits
  (`tests/malicious_token.rs`). This pins the behavior for the direct
  token→escrow path; the through-an-intermediate-contract path below is
  still open for reviewer verification.
- Reviewer, please verify: the host's re-entry prohibition applies
  to every path a SEP-41 token could use to reach this contract,
  including through an intermediate third contract.

### T5 — Malicious or non-standard `token` · **Medium**
`token` is any address the payer supplies. The contract trusts it to
behave like SEP-41.
- **Lying token:** a token whose `transfer` succeeds without moving
  anything creates a `Funded` escrow backed by nothing. That only
  affects escrows *in that same fake token*. Other tokens' balances are
  separate, so this is mostly a problem for payees who trust the
  `Funded` status of a token they didn't vet.
- `Shared pool per token:** all escrows in the same token draw from one
  contract balance. If a token ever delivers less than `amount` (a
  fee-on-transfer, rebasing, or clawback-enabled asset), the contract
  holds less than the sum of its escrows in that token. Early payouts
  then use up later escrows' funds, and the last ones fail.
  - Stellar Asset Contracts for issued assets can have **clawback**
    enabled by the issuer. A clawback against the contract address
    removes funds from the shared pool.
- Mitigations:
  - ~~)In `create_escrow`, check the contract's token balance before and
    after the transfer, and reject (or record the real delta) if it
    doesn't rise by exactly `amount`.~~ **Implemented (issue #12):**
    `create_escrow` now rejects with `BalanceMismatch` unless the
    contract's balance rose by exactly `amount` across the transfer
    (`lib.rs:89-94`). Catches the lying-transfer case above and the
    fee-on-transfer/rebasing short-delivery case at creation — both
    covered by mock-token tests (`tests/malicious_token.rs`). What it
    **cannot** catch is a token that takes funds back *after*
    creation: a clawback-enabled issuer can drain the shared pool
    later, and no creation-time check sees that. Accepted residual
    risk for now (documented, deliberately not solved here) — the
    practical mitigation stays with the consumer: allowlist only
    tokens without clawback, transfer fees, or rebasing.
  - **Deploy-time token allowlist (issue #36):** the immutable
    `__constructor(allowed_tokens)` records approved token addresses, and
    `create_escrow` rejects any other token with `DisallowedToken` (error
    code 7). An empty list deliberately preserves the legacy allow-all
    behavior. Deployment operators must omit clawback-enabled, rebasing,
    and fee-on-transfer tokens from the list. This prevents callers from
    introducing arbitrary tokens but cannot stop an approved issuer from
    clawing back funds later. **Not yet implemented in this document's
    scope commit; tracked here as the planned closure of the clawback
    residual above.**
- Reviewer, please verify: the balance-delta check cannot be bypassed
  by a token that reports a fake `balance`, and that the allowlist
  constructor is actually immutable on the deployed WASM.

## 4. Out of scope

This document does not cover the consumer (`docforum-core`) beyond the
PLUGIN releaser key assumption in T1, nor the Stellar network itself.

## 5. Residual risk summary

| Risk | Status |
|---|---|
| Wrong outcome by compromised releaser (T1) | Open — mitigate with multisig (SDK helpers in `sdif/src/multisig.ts`) or HSM/KMS |
| Permanent lock by lost releaser (T2) | Mitigated for escrows with `refund_after`; open for escrows without one |
| Double payout (T3) | Believed mitigated; reviewer to confirm archival/restore path |
| Reentrancy (T4) | Direct path pinned by test; intermediate contract path open for verification |
| Malicious token (T5) | Creation-time short delivery caught; clawback after creation is residual risk |

## 6. Reviewer checklist

- [ ] Verify I1: no code path derives a destination from call arguments.
- [ ] Verify I2: the `refund_after` relaxation only applies to `refund`,
  not `release`, and only after the deadline.
- [ ] Verify I3: no path writes `status` outside `release`/`refund`.
- [ ] Verify I4: the balance-delta check is shared between create and top-up.
- [ ] Verify I5: `condition_ref` is written and never read.
- [ ] Verify T3: archival/restore cannot bypass the status check.
- [ ] Verify T4: the host re-entry rule covers the intermediate-contract path.
- [ ] Verify T5: the balance-delta check cannot be bypassed by a fake
  `balance` response.
- [ ] Verify T1 mitigation: `sdif/src/multisig.ts` refuses lock-out
  configurations (sum of remaining signer weights below the high
  threshold) and always places the master key weight change last.
- [ ] Verify T1 mitigation: `verifyMultisig` reports a mismatch between
  on-chain thresholds/weights and the intended policy.
