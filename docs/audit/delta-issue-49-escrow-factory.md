# Audit delta: isolated escrow factory

- **Code commit:** `264497a` (the merge commit; this note follows it).
- **Frozen review baseline:** `797c1170516847b64ef2b10df3d2abd517248284`.
- **Diff scope:** baseline-to-current-main changes included by merging `9d81349`, plus this PR's factory contract, integrator metadata, tests, generated binding, and security documentation. Review the full diff against the frozen baseline; this note summarizes the factory-specific risks.
- **Review status:** delta review requested; no independent security review is claimed.

## Changed behavior

The factory pins an escrow WASM hash and deploys at most one deterministic escrow instance per integrator. The integrator authorizes deployment. The instance address is derived from a domain-separated salt scoped to the factory, and the registry exposes the deployed address and prediction. Each child stores its integrator as informational metadata; the factory has no child administration or upgrade entry point. Contract version advances to 2.3.0 for the constructor metadata addition.

## Incremental threats and controls

- A caller cannot deploy for another integrator without that integrator's authorization. Registry checks prevent a second instance for the same integrator.
- The pinned hash prevents an operator from selecting arbitrary child code after factory deployment. There is no factory upgrade or child administration path; compromise or incorrect selection at factory deployment remains a deployment-time risk.
- Salt derivation includes a fixed domain symbol and the integrator, with the current factory address applied by Soroban's deployer. Tests cover address prediction, separate instances, registry contents, and duplicate deployment rejection.
- Children keep an empty token allowlist by default, preserving the existing unrestricted-token behavior. Integrators must review token trust and contract versions before funding a child.
- Current-main changes to liabilities, fees, batch settlement, and related escrow behavior are also in the baseline-to-current diff and need review as part of the complete delta.

## Validation

The full Rust contract workspace, Rust formatting check, release WASM build, generated-binding check, and resource-baseline check pass locally. The Go quickstart integration previously failed during contract deployment with a generic Soroban `HostError`; the branch update will trigger a fresh CI run. The malware scan on the pre-merge PR head passed; the updated head requires a new scan.
