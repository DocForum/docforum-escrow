Redeployed contract 2.5.1 to testnet as
`CAANBNO7UXU24RVORQSGV33VJ7ZPL4UQKQNGPOSCSDDLISQ35SH62Y6E` with `scripts/deploy`
(source `52a6a39`), so the deployment now matches the SDK's `create_escrow` and
has the emergency pause. All six scripted live checks passed; `pause_admin` is
`GDJBRSDH4OARYUYDUDUXYTELZQMIJVZBLL4H2CDQFOHMNKNGE4ILUM7T`. The SDK testnet
preset, README and `fees.test.ts` now use the new id. Exercising
`pause`/`unpause` live, including a release while paused, is still open under
Phase E5. docforum-core stays on its own older contract and SDK 0.2.0 for now.
