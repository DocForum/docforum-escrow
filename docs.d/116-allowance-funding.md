---
file: docs/threat-model.md
section: 2. Assets and actors
---
| `spender` | When the payer uses `create_escrow_from`, spends only the payer's explicitly approved allowance to fund one escrow | Nothing after creation unless separately named as a releaser; it cannot change the stored payee, refund destination, or other escrow rules. |
