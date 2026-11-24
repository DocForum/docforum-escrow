Issue #333 (Phase E7): the SDK's hand-mirrored contract limits are now checked
in CI. `scripts/check-sdk-constants.mjs` parses `pub const NAME: type = value;`
from `contracts/escrow/src/` and `export const NAME = value;` from
`sdk/src/`, compares every entry in its contract → SDK mapping table, and
fails on a mismatch, a constant missing from either side, or an SDK constant
that shadows a contract limit without being mapped. Underscored literals
(`1_000`, `518_400`) parse. The check runs in the `Contract interface
snapshot` CI job. Exported `MAX_SETTLE_OPS` (12) from the SDK — it was not
mirrored at all — and corrected `README.md`/`ARCHITECTURE_ESSENTIALS.md`, which
said 20. No contract change.
