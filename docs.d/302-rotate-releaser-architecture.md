---
file: ARCHITECTURE_ESSENTIALS.md
after: "configured escrow. Signer additions/removals and threshold changes use a"
---
The account also accepts one `rotate_releaser` context on its configured escrow when it is the context's `caller`; the payer's separate authorization remains required, and the rotation consumes one per-window operation slot (ADR 0008).
