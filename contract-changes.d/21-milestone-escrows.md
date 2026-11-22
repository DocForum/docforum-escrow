Issue #21 changes the escrow contract surface with
`create_escrow_with_milestones`, `get_milestones`, and `release_milestone`,
plus appended milestone storage and errors 35–38. Regenerate SDK bindings
from the built WASM before publishing a client for this surface. The existing
single-tranche entry points remain compatible.
