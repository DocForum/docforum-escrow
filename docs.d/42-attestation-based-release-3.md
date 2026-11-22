---
file: docs/threat-model.md
section: "## 3. Threats"
---
### T42 — `attester` key compromised, lost, or attestation replayed · **Medium**

- **What changed:** Phase E5 (issue #42) lets an escrow carry an optional
  `attester` (an ed25519 public key), and lets anyone submit a signed
  attestation to release it via `release_with_attestation`. The attester
  signs offline with a cold key; the releaser no longer has to be online,
  funded, or holding a hot key at release time. The attestation is a
  signature over a domain-separated message (contract id, network id,
  escrow id, action `release`) verified with `env.crypto().ed25519_verify`.
- **Key compromised:** if the attester key is stolen, the attacker can sign
  a release attestation for any escrow naming that attester and submit it
  at any time, so the payout happens early. Blast radius is limited to
  escrows naming that attester; the releaser and payer keys are unaffected,
  and the releaser can still refund (only to the payer) while the escrow
  is `Funded`, if they spot the compromise in time. Treat the attester key
  like the releaser key in T1: cold storage, single purpose, rotate the
  escrow rather than the key if it is exposed.
- **Key lost:** if the attester key is lost, the attestation path is dead,
  but the escrow is not stuck — the stored releaser can still release, and
  the refund path is unchanged. A lost attester key is a degraded release
  path, not a loss of funds.
- **Replay:** an attestation cannot be replayed on another contract or
  another network — the signed message binds the contract id and the
  network id, and a testnet attestation will not verify on mainnet. It
  cannot be reused on the same escrow either: release settles the escrow,
  so a second submission fails. The verification cost is a single
  `ed25519_verify` call, the same primitive the host uses for auth checks;
  no measurement was run for this change, so the cost still needs a
  testnet run to confirm.
- **What is still missing:** there is no way to rotate or revoke an
  attester once set, and no way to list escrows by attester. A compromised
  attester stays valid for every escrow that names it until each one
  settles. Tracked as a follow-up, not a blocker.
- **Residual risk:** accepted. The cold-key attestation path is strictly
  safer than the hot-key releaser path it replaces (T1), and the same
  escrow is still releasable by its releaser.
