# Escrow factory

`docforum-escrow-factory` deploys one escrow instance per integrator from a
pre-uploaded escrow WASM hash. The derived deployment salt includes both the
integrator address and the caller-supplied salt, so integrators cannot collide
with one another. The factory records only the registry mapping; it has no
admin or upgrade authority over deployed instances.

Build and test with:

```bash
cargo test --manifest-path contracts/factory/Cargo.toml
```
