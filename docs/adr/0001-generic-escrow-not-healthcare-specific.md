# ADR 0001: Contract stays generic, condition_ref is opaque

Status: Accepted

## Decision
The escrow contract does not know what a "fulfillment" or "referral" is.
It exchanges an opaque `condition_ref` and enforces WHO may call
release/refund, not WHY. All domain interpretation happens in the
consuming application (docforum-core).

## Why
Keeps this repo reusable beyond DocForum, keeps PHI structurally
impossible to introduce here, and matches the pattern of other approved
Stellar Wave escrow repos (e.g. Trustless Work) rather than building a
bespoke healthcare-coupled contract.
