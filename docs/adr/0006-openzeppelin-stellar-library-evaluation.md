# ADR 0006 — OpenZeppelin Stellar contract libraries: evaluate before adopting

- **Status:** Accepted (2026-10-20)
- **Phase:** E5 — Contract features (issue #118)
- **Deciders:** contract maintainers
- **Related:** [ADR 0001](0001-generic-escrow-not-healthcare-specific.md)
  (generic, domain-blind contract), [ADR 0002](0002-per-escrow-releaser-set-at-creation.md)
  (per-escrow releaser, no contract-level admin),
  [ADR 0007](0007-in-contract-m-of-n-releaser-quorum.md) (the M-of-N feature
  implemented alongside this evaluation), `docs/threat-model.md`
  (§2 "no admin, no upgrade function, and no pause", T1–T8).

## Context

Several features raised for this contract — pause, upgradeability, multisig,
roles — already exist, audited, in the
[OpenZeppelin Stellar contracts library](https://github.com/OpenZeppelin/stellar-contracts)
(`stellar-access`, `stellar-contract-utils`, `stellar-accounts`,
`stellar-tokens`, `stellar-governance`, `stellar-macros`). Reusing audited
building blocks instead of hand-rolling them is normally the right default for
a funds-moving contract. Issue #118 asks for an explicit evaluation against
this contract's constraints before any of it is pulled in.

The constraints are not incidental — they are the design:

1. **ADR 0001:** the contract enforces *who* may act, never *why*. It stays a
   generic escrow primitive; no domain logic and no integrator-specific policy.
2. **ADR 0002:** authority is per escrow. There is deliberately **no**
   contract-level admin, owner, or upgrader.
3. **`docs/threat-model.md` §2** states the property payees rely on: the
   deployed WASM is immutable, and nobody — including the deployer — can move
   funds outside `release`/`refund`.
4. **Hard rule 4:** testnet only until the Phase E4 security review is done.
   Nothing here changes that.
5. The deployed contract is live on testnet; any behavioural change is a
   breaking change for the SDK (hard rule 3) and needs a new deployment.

## What was evaluated

Versions checked on 2026-10-20:

| Package | Latest stable | `soroban-sdk` requirement | Notes |
|---|---|---|---|
| `stellar-contract-utils` | 0.7.2 (2026-06-09) | `^26.1.0` | pausable, upgradeable, utility modules |
| `stellar-access` | 0.7.2 (2026-06-09) | `^26.1.0` | `Ownable`, `AccessControl`, role transfer |
| `stellar-macros` | 0.7.2 (2026-06-09) | `^26.1.0` | used by the two above |
| `stellar-accounts` | 0.7.2 | `^26.1.0` | smart-account abstraction |
| `stellar-tokens` | 0.7.2 | `^26.1.0` | fungible/NFT implementations |

This repository pins `soroban-sdk = "27.0.6"`. The library's `main` branch has
since moved to `soroban-sdk 28.0.0`; the `0.8.0-rc.*` tags are pre-releases and
are not published as stable crates. **There is no stable OZ Stellar release
that supports the SDK major version this contract uses.**

## Module-by-module evaluation

### Pausable — **rejected**

- It requires an owner-like address (`#[only_owner] fn pause(...)`) to pause
  and unpause. That is precisely the contract-level privileged role ADR 0002
  rejected, and a reviewer would have to ask "who can unpause, and what happens
  to a payee while it is paused?" — with no good answer for an escrow that is
  supposed to settle unconditionally.
- A pause switch also *creates* a new failure mode: whoever can pause can stop
  every release and every timeout refund. For a payee, a `Funded` escrow that
  cannot be released is worse than a contract with no pause at all.
- It does not mitigate the threat that actually matters here (T1, a leaked
  releaser key): pausing does not stop a stolen key from settling an escrow.

### Upgradeable — **rejected**

- It requires an upgrader/admin address and replaces the immutable-WASM
  guarantee in `docs/threat-model.md` §2 with "trust the upgrader". That
  guarantee is a documented property of this primitive, not an implementation
  detail.
- Upgrades plus per-escrow storage are also a migration hazard: any change to
  `EscrowData` has to be handled by an explicit migration, and the escrow's
  participants have no say in it.
- Mainnet deployment is blocked on the Phase E4 review; adding upgradeability
  before that review would make the review harder, not easier.

### `Ownable` / `AccessControl` / roles — **rejected**

- Any of these introduces a contract-level authority, contradicting ADR 0002's
  per-escrow releaser decision and the "no hidden admin" rule in the issue.
- The one place authority is needed is per escrow, and that is already modelled
  directly by `releasers`/`threshold` (ADR 0007) with no global role.

### Smart-account / multisig account modules — **not adopted (out of scope)**

- A releaser can already be a classic or smart multisig account, because
  Soroban's `require_auth` honours the account's own signer thresholds. Nothing
  in this contract prevents that, and users who can manage accounts should keep
  using it — the in-contract quorum (ADR 0007) is an alternative for those who
  cannot, not a replacement.
- Pulling in `stellar-accounts` would put account-abstraction policy inside an
  escrow contract, violating ADR 0001.

### `stellar-tokens` — **not needed**

- This contract holds and moves an existing SEP-41 token; it does not issue
  one. The library's token implementations are irrelevant here.

### Governance / timelock / confidential / zk-email — **not applicable**

- No governance process, no confidentiality requirement (the contract is
  deliberately public and generic), and no email proofs in scope.

### `stellar-contract-utils`' reentrancy pattern — **adopted as a pattern, not as a dependency**

- The library's audited guidance on ordering (checks → effects → interactions)
  addresses threat model T4, which the current code got wrong: `release` and
  `refund` called the token's `transfer` **before** writing the settled status,
  relying solely on the Soroban host's re-entry prohibition.
- Since the crate itself cannot be linked (SDK major mismatch), the same
  ordering is now implemented directly in `contracts/escrow/src/lib.rs`
  (`settle()` writes the status, then transfers). This is the part of the OZ
  design that fits this contract's constraints — no role, no code change to the
  public interface — and it costs nothing.
- A failing payout rolls the whole invocation back (tested in
  `tests/malicious_token.rs::failed_payout_leaves_the_escrow_funded`), so an
  escrow can never end up `Released` with the funds still in the contract.

## Decision

1. **Adopt no OpenZeppelin crate at this time.** Not because the modules are
   poorly built — they are audited — but because the only modules that fit this
   contract's new-feature wish list (pause, upgradeability, contract-level
   roles) are exactly the ones its design rules forbid, and the remaining
   non-privileged pattern (reentrancy ordering) can be implemented directly
   without a dependency that cannot be linked.
2. **Adopt the checks-effects-interactions ordering** from the OZ pattern, in
   `release` and `refund` (both single-caller and approval paths), with a
   regression test.
3. **Keep the public interface unchanged** by this ADR. No pause, no upgrade,
   no owner, no migration hook is added.
4. **Re-evaluate when** a stable OZ Stellar release supports the
   `soroban-sdk` minor this contract uses **and** a feature the ADR rules
   permit (i.e. one that introduces no contract-level authority) needs it. The
   first candidate would be a genuinely non-privileged utility; pause and
   upgradeable stay rejected unless ADR 0002 and threat model §2 are revised
   first.

## Dependency pinning and update policy

This applies to every Rust dependency of the contract, and is the policy the
issue asks to record:

- `soroban-sdk` is pinned to `27.0.6` in `contracts/escrow/Cargo.toml` and
  `Cargo.lock` **is committed**. CI builds against the committed lockfile.
- If an OZ crate is ever adopted, it must be pinned to an **exact** version
  (`=0.7.2`, not `^0.7.2`), because the contract is deployed immutably: a
  silent minor bump that changes behaviour between a test run and a wasm build
  is not acceptable.
- A dependency bump is its own PR, with: the upstream changelog and audit
  report referenced, contract tests green, wasm size and instruction-cost
  numbers re-measured (see below), the bindings regenerated
  (`scripts/check-generated-bindings.sh`), a testnet redeploy record, and a
  ROADMAP changelog line.
- Security advisories for `soroban-sdk` and any adopted library are treated as
  deployable incidents: rebuild, retest, redeploy, and note it in
  `docs/testnet-deployments.md`.
- Pinning of the *tooling* that generates the SDK bindings is separate and
  recorded in `scripts/stellar-cli-version` (issue #121).

## Consequences

- No change to the dependency graph, so no new supply-chain surface, no second
  `soroban-sdk` major, and no audit debt.
- The team keeps maintaining the small amount of bespoke logic it already had;
  that logic is now smaller and more defensive (`settle()`), not larger.
- If pause or upgradeability ever becomes a hard requirement, this ADR must be
  superseded explicitly, with ADR 0002 and threat model §2 revisited in the
  same change — that is the intended cost of the decision.
- The features that were actually requested by integrators (multisig-style
  settlement without managing a multisig account) are delivered by ADR 0007
  instead, inside the existing authority model.

## Cost comparison (measured, not estimated)

Measured on 2026-10-20 with `env.cost_estimate().budget()` in the test
environment (`mock_all_auths`, so signature verification is **not** included),
same machine and toolchain for both builds:

| Operation | Before (`main`) | After this PR | Δ |
|---|---|---|---|
| `create_escrow` | 443,350 CPU / 142,063 mem | 450,433 CPU / 145,215 mem | +1.6% CPU |
| `top_up` | 460,196 CPU / 139,249 mem | 465,169 CPU / 142,395 mem | +1.1% CPU |
| `get_escrow` (1 releaser) | 71,653 CPU / 37,981 mem | 75,043 CPU / 40,685 mem | +4.7% CPU |
| `release` | 327,686 CPU / 127,936 mem | 331,825 CPU / 130,914 mem | +1.3% CPU |
| `refund` | 330,136 CPU / 123,547 mem | 334,810 CPU / 126,618 mem | +1.4% CPU |
| wasm size | 24,516 bytes | 29,338 bytes | +19.7% |

The entire delta comes from the M-of-N feature (ADR 0007): one extra `Vec`
field in `EscrowData`, threshold validation, and two extra entry points (whose
doc comments are part of the contract spec in the WASM). **Zero** of it comes
from library code, because no library code was added. The wasm increase is
mostly the contract spec strings for the new functions; the settlement paths
themselves move by ~1.3–1.6%. Reproduce by adding a temporary test that prints
`env.cost_estimate().budget().cpu_instruction_cost()` /
`memory_bytes_cost()` after each call, as this ADR's numbers did.

## References

- OpenZeppelin Stellar contracts: <https://github.com/OpenZeppelin/stellar-contracts>
- OZ Stellar docs (pausable, upgradeable): <https://docs.openzeppelin.com/stellar-contracts>
- Library audits: 0.1.0 (2025-02-21) and 0.3.0-rc.2 (2025-07-10) reports on
  openzeppelin.com/news.
- Issue #118.
