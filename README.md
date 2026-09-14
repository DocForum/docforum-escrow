# docforum-escrow

A Soroban (Stellar) escrow contract + TypeScript client SDK
(`@docforum/escrow-sdk`) for conditional payment release: lock funds, and
release them only when a defined condition is confirmed externally.

This repo is deliberately **generic and healthcare-agnostic** — it knows
nothing about patients, doctors, or referrals. It's a reusable
create/release/refund escrow primitive, in the same category as existing
Stellar Wave repos like Trustless Work. Domain-specific logic (what
condition triggers release, who the parties are) lives in the consuming
application — currently [`docforum-core`](../docforum-core)'s `payments`
module, via this package as a dependency (never as a network call — see
`docforum-core`'s `docs/adr/0002-stellar-escrow-for-fulfillment-payout.md`).

## Why this repo exists, honestly
Two reasons, stated plainly rather than blended together:
1. Product reason: `docforum-core`'s facility-fulfillment flow needs a way
   to hold payment until a facility confirms it did the work, without
   trusting the facility's self-report alone.
2. Ecosystem reason: this is the one piece of the DocForum org that's
   actually built *on* Stellar, as opposed to a healthcare app that merely
   accepts Stellar payments — see the org-level discussion in
   `docforum-core`'s architecture docs for why that distinction mattered
   for how this org is structured.

**Status:** scaffolded, no contract code written yet. See `ROADMAP.md`.
