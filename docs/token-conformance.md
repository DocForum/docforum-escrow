# Token conformance — what the escrow supports, and how tokens differ

> Issue #133 (Phase E7). The escrow contract claims to work with **any
> SEP-41 token**. This document is the evidence: a parameterised test suite
> (`contracts/escrow/tests/token_conformance.rs`) runs the whole escrow
> lifecycle against each kind of token implementation, and this page records
> what differs between them.
>
> No PHI, no healthcare concepts — this repo stays domain-blind
> (`docs/adr/0001`).

## What the contract actually needs from a token

The escrow calls exactly two token functions, through the generic SEP-41
client (`soroban_sdk::token::Client`):

| call | why |
|---|---|
| `balance(address) -> i128` | the balance-delta check on funding (threat model T5): the contract's balance must rise by exactly `amount` |
| `transfer(from, to, amount)` | pulling the funds in and paying them out |

Nothing else. No `approve`, no `allowance`, no `burn`, no admin function, no
issuer flag. A token that implements those two functions — with SEP-41's
argument types — works with this contract, whatever else it does or does not
implement.

## The conformance matrix

| token kind | what it is | decimals | how the suite funds it |
|---|---|---|---|
| `native_sac` | the Stellar Asset Contract for the native asset (XLM) | 7 (fixed by the protocol) | transferred from a ledger account that already holds XLM — the native asset **cannot be minted** |
| `issued_sac` | the Stellar Asset Contract for an issued (credit) asset, issuer flags **unset** | 7 (fixed by the protocol) | minted by the token's administrator |
| `custom_sep41_7` | a Wasm contract implementing SEP-41 (an OpenZeppelin-style fungible token) | 7 (chosen at deploy) | minted through the token's own admin function |
| `custom_sep41_6` | the same contract, deployed with 6 decimals (USDC and friends) | 6 (chosen at deploy) | minted through the token's own admin function |

Every lifecycle case runs against all four:

`create_escrow` (funds locked, status `Funded`) · `release` (payee paid) ·
double release rejected · release by a stranger rejected · `refund` (payer
made whole) · refund by a stranger rejected · refund after release rejected ·
`top_up` (and the top-up is paid out too) · payee-acceptance gate ·
M-of-N release with distinct approvals · timeout refund open to anyone after
the deadline · the amount is an opaque integer unit · account payer trustline
rules · account payee payout rules.

Run them locally:

```bash
cd contracts/escrow
cargo test --test token_conformance
```

CI runs them as their own job (`.github/workflows/ci.yml`, `token-conformance`).

## Behaviour differences between the token kinds

| | native SAC (XLM) | issued-asset SAC (no flags) | custom SEP-41 token |
|---|---|---|---|
| contract address | fixed and identical on every network: `CB56OQJZFJXSSKFK3MXJZ4TLJAJFWH6KXN6BAWHQSJDZPHZFVBJ353HU` | derived from the asset (issuer + code) | wherever it was deployed |
| `decimals()` | always 7 | always 7 | whatever the deployer chose (the suite runs 6 and 7) |
| `name()` / `symbol()` | `"native"` / `"native"` | `"aaa:G…"` / `"aaa"` | the deployer's choice |
| can it be minted? | **no** — nobody can mint XLM; balances only move | yes, by the issuer's administrator | implementation-defined (SEP-41 has no minting function at all) |
| administrator surface | none (no `set_admin`, no `mint`, no `clawback`) | the issuer's account: `mint`, `clawback`, `set_authorized`, `set_admin` | whatever the token defines — this is where an OZ-style token differs from a SAC |
| issuer flags | n/a | **none in this suite** (see the scope note below) | n/a |
| how an account (`G…`) holds a balance | the account's own native balance — no trustline | a **trustline** on the account; the account must call `trust()` first | the token's own ledger — no trustlines |
| `balance()` of an account without a trustline | works | **fails** (`TrustlineMissingError`) | works |
| `transfer` destination type | `MuxedAddress` (SEP-41) | `MuxedAddress` (SEP-41) | `MuxedAddress` (SEP-41) — a plain `Address` also works *with this contract*, see below |
| balance storage | the SAC's contract storage (for contract addresses) or the ledger (for accounts) | the same, plus trustlines for accounts | the token's own contract storage |
| `transfer` events | SEP-41 `transfer` event | SEP-41 `transfer` event | implementation-defined; the escrow never reads token events |
| escrow compatibility | full | full | full |

### What the differences mean in practice

**Decimals are the integrator's job.** The escrow stores and moves the amount
as an opaque `i128` — it never reads `decimals()` and never rescales. One
USDC (6 decimals) is `1_000_000` units; one XLM (7 decimals) is `10_000_000`
units. Both are just integers to the contract, and the suite pins that: the
same escrow of `1` unit works against a 0-, 2-, 6-, 9- and 18-decimal token
(`amounts_pass_through_unchanged_for_every_decimals_setting`). Get the scaling
wrong in the calling application and the escrow will faithfully hold the
wrong amount.

**A credit asset needs a trustline on both sides.** This is the difference
that surprises people. With an issued asset, an account cannot hold the
asset — and therefore cannot be the payer or the payee of an escrow — before
it has asked the token for a trustline (`trust()` on the SAC). Without one:

- the payer cannot be funded, so `create_escrow` fails;
- the payee cannot be paid, so `release` fails — and, like any failed
  payout, it **rolls back atomically**: the escrow stays `Funded` and the
  money stays in the contract until the payee has a trustline.

The native asset and custom tokens have no trustlines at all, so the same
code path just works. Contract addresses (`C…`) never need a trustline in any
token kind — their balances live in the token's contract storage.

**The escrow always sends a plain destination address.** The escrow pays a
payee with a contract or account address, never a muxed one, so it hands the
token a plain `Address`. A token whose `transfer` declares a `MuxedAddress`
destination (SEP-41's rule, and what the SAC does) accepts that fine — and a
token that declares a plain `Address` also works *with this contract*
(`a_token_that_takes_a_plain_address_destination_still_works`). The latter is
not a conformant SEP-41 implementation: it cannot receive muxed payments, so
other integrators would trip over it. Prefer a real SEP-41 token.

**A token that lies about the transfer is rejected, not paid.** The
balance-delta check (T5) means a token that reports success without moving
the funds makes `create_escrow` fail with `BalanceMismatch`. The mock tokens
in `tests/malicious_token.rs` cover the deliberate cases (lying transfer,
fee-on-transfer, re-entry, failing payout); the conformance suite covers the
honest ones.

**Tokens have different admin surfaces.** The SAC for an issued asset has an
administrator that can mint, claw back and authorize; the native asset has
no administrator at all; a custom token has whatever its author wrote. The
escrow uses none of it — but an integrator choosing a token is choosing that
surface too, and the deploy-time token allowlist (`__constructor(allowed_tokens)`)
is where a deployment pins the decision.

## Scope: implementations, not issuer flags

This suite is about **token implementations**. Issuer flags — clawback,
auth-required, revocable — are properties of an *issuer*, not of a token
contract, and they are tracked separately:

- the issued SAC in this suite is registered with **no flags at all**;
- the clawback / auth-required edge cases live in the threat model
  (`docs/threat-model.md`, T5) and are about the shared-pool risk, not about
  compatibility;
- a clawback-enabled issuer can drain the shared pool *after* an escrow was
  funded — no creation-time check can see that. It is an accepted residual
  risk, mitigated by the deploy-time allowlist.

## Recommended tokens for integrators

1. **The native asset (XLM)** — the strongest default: no issuer, no
   administrator, no flags, so nobody can claw the escrowed funds back after
   the fact. It is the token the live testnet deployment is exercised with,
   and the suite proves the full lifecycle against it.
2. **A Stellar Asset Contract for an issued asset with no issuer flags**
   (USDC and similar) — fine, with two operational requirements: the payer
   and the payee must both hold a **trustline** for the asset, and the
   amount must be scaled to the asset's decimals (USDC: 6). Verify the
   issuer's flags before deploying, and keep the asset out of any
   clawback-enabled issuer.
3. **A well-known custom SEP-41 token** (e.g. an OpenZeppelin-style
   fungible token) — supported, provided it implements `balance` and
   `transfer` with SEP-41's argument types (`transfer`'s destination is a
   `MuxedAddress`). The suite runs the full lifecycle against one.

Before deploying, pin the accepted tokens in the contract's deploy-time
allowlist (`__constructor(allowed_tokens)`) and check each of them against
this table.

## Where this lives

| file | what |
|---|---|
| `contracts/escrow/tests/token_conformance.rs` | the parameterised suite (one test module per token kind) |
| `contracts/escrow/tests/conformance/mod.rs` | the harness: token kinds, funding per kind, the lifecycle cases |
| `contracts/escrow/tests/conformance/oz_token.rs` | the custom SEP-41 token used as the third implementation |
| `contracts/escrow/test_snapshots/<token kind>/` | the committed snapshot per case, per token — the per-token behaviour differences are visible in the diff |
| `docs/threat-model.md` (T5) | the malicious / non-standard token analysis this suite sits next to |
