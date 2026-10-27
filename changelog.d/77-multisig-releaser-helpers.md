Phase E6 (issue #247): added multisig releaser setup helpers to the SDK.
`buildMultisigSetup` returns one atomic `setOptions` transaction (thresholds,
one operation per signer, master key weight zeroed last) and refuses any
configuration that would lock the account out; `dryRunMultisigSetup` and
`verifyMultisig` cover review and on-chain verification. Client-side only — no
contract change, so the generated bindings are unchanged.
