bump: patch
---
Issue #8: reject escrow creation when the escrow contract itself is configured as the payee or releaser, preventing funds from being locked without a usable recipient.
