# Security Policy

How to report a vulnerability in this repository, how reports are handled, and
what the audit package under `docs/audit/` may contain.

This project is **testnet only**. No deployment has been reviewed for mainnet,
and nothing here is a production security guarantee.

## Supported versions

Fixes land on the latest commit of `main` and, for the SDK, in the latest
published minor version. Please reproduce findings against current `main`
before reporting.

## Reporting a vulnerability

**Do not open a public issue or pull request for an undisclosed
vulnerability.**

Use GitHub's private vulnerability reporting:

1. Open the repository's **Security** tab → **Report a vulnerability**.
2. Include the affected component (contract entry point, SDK module, or
   documentation file), the commit you tested, reproduction steps, and the
   impact you believe it has.
3. If private reporting is unavailable, ask a maintainer (see
   `CONTRIBUTING.md`) for a private channel before sharing details.

A minimal reproducer helps most: for contract issues, a failing test in
`contracts/escrow/tests/` is ideal.

## Triage and tracking

Each accepted report is tracked as a **GitHub private security advisory** on
this repository. Public issues are only for findings that are already
disclosed or that the reporter and maintainers agree are non-sensitive.

- One advisory per distinct finding; do not bundle unrelated issues.
- Severity is recorded in the advisory with a justification.
- Fixes land through the normal PR flow, referencing the advisory; the
  advisory is published once a fix is merged or the embargo ends.

## Disclosure

- **Embargo:** until a fix is merged, or 90 days after triage acceptance,
  whichever comes first. Maintainers will agree a date with the reporter.
- **Credit:** reporters are credited in the advisory unless they ask not to be.
- **No premature publication:** an undisclosed finding must not appear in
  `docs/audit/`, `docs/threat-model.md`, a commit message, a test name, or a PR
  description. Reference the advisory instead.

## The audit package and its scope

`docs/audit/` holds the material an external reviewer needs: the reviewed
scope, the threat-model summary, known issues and accepted risks, and the test
results for that scope. See [`docs/audit/README.md`](docs/audit/README.md).

- The package is public by default. Treat every line as if an attacker will
  read it.
- Undisclosed findings are referenced by advisory ID and status only; details
  live in the advisory.
- Accepted risks that are already public (code comments, issues, this
  document, the threat model) may be described in full.
- Changes to in-scope files after the freeze need a delta review recorded in
  `docs/audit/`; do not amend frozen artifacts in place.

## Scope of this policy

In scope:

- The Soroban contract under `contracts/escrow/` and the releaser account
  contract under `contracts/releaser-account/`.
- The TypeScript SDK under `sdk/` and the React hooks package under
  `packages/escrow-react/`.
- The threat model and audit package under `docs/`.

Out of scope:

- Deployment infrastructure and operational processes not committed here.
- Third-party dependencies — report those upstream and reference the advisory
  here if this repo is affected.
- Social engineering and physical access.

## Constraints for fixes

- No PHI or healthcare concepts may be introduced anywhere in this repository.
- Behaviour changes to the contract need tests in `contracts/escrow/tests/`.
- SDK changes follow strict semver; a breaking change needs a major bump.
- This project is testnet only: a finding that depends on mainnet assumptions
  is not an in-scope defect here, but say so and we will still look at it.

## Safe harbour

Good-faith research against this repository and its testnet deployments is
welcome. We will not pursue legal action against researchers who follow this
policy, avoid privacy violations and service degradation, and give us
reasonable time to respond before public disclosure.
