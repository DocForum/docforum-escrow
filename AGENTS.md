# AGENTS.md — docforum-escrow

Instructions for coding agents working in this repo.

Read `README.md` and `ARCHITECTURE_ESSENTIALS.md` in this repo first — this
repo is intentionally scoped narrowly and self-contained. You should not
need `docforum-core`'s docs to work here; if you find yourself needing
healthcare/PRD context to make a decision in this repo, that's a signal
the change belongs in `docforum-core` instead, not here.

## Non-negotiable rules
- No PHI. No healthcare domain concepts (patient, doctor, referral, etc.)
  anywhere in this repo — see `ARCHITECTURE_ESSENTIALS.md` hard rule 1.
- Contract changes need contract tests in the same PR, always.
- Testnet only, per `ARCHITECTURE_ESSENTIALS.md` hard rule 4, until an
  explicit security-review milestone (ROADMAP.md Phase E4) is marked done.
- Update `ROADMAP.md` on every contribution — org-wide rule, applies here
  too.
