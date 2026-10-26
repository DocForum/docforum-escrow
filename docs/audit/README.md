# Audit readiness package

Material for an independent review of the escrow contract, collected so
reviewers work from a fixed scope instead of chasing `main`.

## Frozen scope

- **Reviewed code commit:** `797c1170516847b64ef2b10df3d2abd517248284`
  (current `main` when this package was written).
- **This package's diff against that commit is documentation only.** It adds
  `SECURITY.md`, this directory and an audit-readiness section in
  `CONTRIBUTING.md`, and updates `docs/threat-model.md`. No contract, SDK or
  workflow file changes, so the reviewed code above is exactly what a reviewer
  sees on `main`.
- **In scope:** `contracts/escrow/src/lib.rs`, `contracts/escrow/tests/`,
  `contracts/releaser-account/`, the generated bindings check, and the
  threat model in `docs/threat-model.md`.
- **Out of scope:** `sdk/`, `indexer/`, `packages/`, deployment scripts and
  `docs/testnet-deployments.md`.

If code changes after that commit, do not edit this package in place. Add a
delta document (`docs/audit/delta-<n>.md`) naming the new commit, the diff
since `797c117`, and the incremental threat analysis, and request a delta
review.

## What is actually implemented

The reviewed commit implements: `create_escrow`,
`create_escrow_release_time`, `create_escrow_with_acceptance`, `accept`,
`create_escrow_with_releasers`, `get_status`, `get_escrow`,
`rotate_releaser`, `top_up`, `release`, `release_with_approvals`, `refund`,
`refund_with_approvals` and `cancel`, plus the immutable deploy-time token
allowlist in `__constructor`.

The threat model also describes Phase E5 features that are **not implemented
in this commit** — milestones, disputes, splits, per-escrow attestations. They
are recorded as planned risk areas in `docs/threat-model.md` §3 (T12) only so
that the analysis is ready when they land; there is nothing to review for them
yet. Do not read T12 as current behaviour.

## Contents

| File | Purpose |
|---|---|
| [`test-and-benchmark-results.md`](./test-and-benchmark-results.md) | How to reproduce the test suite, WASM build and SDK checks, with the results observed at this commit. |
| `../threat-model.md` | Invariants, actors, the STRIDE pass per threat, and the pre-mainnet checklist. This is the canonical threat model. |
| `../adr/` | The decisions the threat model refers to (per-escrow releaser, timeout refund, M-of-N quorum, acceptance gate, sponsored refunds). |
| `../testnet-deployments.md` | Current testnet deployment and verification history (out of scope, for context). |

There is no `KNOWN-ISSUES.md` yet. Known issues live in GitHub issues; accepted
risks are stated inline in the threat model. Adding a separate risk register
before the first external review would duplicate both.

## Reporting findings

Follow [`SECURITY.md`](../../SECURITY.md). In short: report privately, include
the commit above and the affected entry point, and do not put an undisclosed
finding in this directory.

## Review checklist

- [x] Reviewed commit recorded, with the package's own diff described.
- [x] In-scope and out-of-scope files listed.
- [x] Threat model covers the implemented entry points and roles.
- [x] Test and build results reproducible from the documented commands.
- [x] Reporting path documented in `SECURITY.md`.
- [ ] Fuzz targets — none exist in this commit.
- [ ] Formal verification — no machine-checked proofs exist in this commit.
- [ ] Benchmarks — only a source-size baseline, no cost measurements yet.
- [ ] Independent review of the threat model and contract (issue #6).
