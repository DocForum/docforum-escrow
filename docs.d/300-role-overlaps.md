---
file: docs/threat-model.md
section: T8 — Payee has no protection against the releaser · **By design, document it**
---

#### Role-overlap matrix (issue #300)

Role overlap is allowed unless a row says otherwise. The payer chooses these
addresses at creation, so the overlap is part of the deal and must be visible
to the payee in `get_escrow` before relying on the escrow.

| Overlap | Allowed? | Implication |
|---|---|---|
| `payer == payee` | Yes | Release pays the payer; this is a valid self-funded escrow. |
| `payer == releaser` | Yes | The payer can choose release or refund, so the payee has no independent settlement protection. |
| `payer == refund_to` | Yes | This is the default refund destination. |
| `payer == fee_recipient` | Yes | The payer receives the configured release fee. |
| `payee == releaser` | Yes | The payee may authorize its own release. |
| `payee == refund_to` | Yes | A refund sends the funds to the payee. |
| `payee == fee_recipient` | Yes | The payee receives both the fee and the release remainder. |
| `releaser == refund_to` | Yes | The releaser can direct a refund to itself when the payer configured it. |
| `releaser == fee_recipient` | Yes | The releaser receives the configured release fee. |
| `refund_to == fee_recipient` | Yes | The same destination receives a refund or the release fee, as applicable. |

The contract address is not a user-role overlap: it is rejected as
`refund_to` or `fee_recipient` because funds sent there would be permanently
stranded. Contract-self `payee` and `releaser` remain the separate design
question tracked by issue #8 and are not changed here.
