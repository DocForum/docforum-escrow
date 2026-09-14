# Testnet deployments

## `docforum_escrow` — 2026-09-14

| | |
|---|---|
| Network | Stellar Testnet (`Test SDF Network ; September 2015`) |
| Contract ID | `CABSYY5FZGCCZ3UTBQGC7S357D2FUFLUQUUGJCCFHKGEJZVIFK4SIS2Z` |
| Explorer | https://stellar.expert/explorer/testnet/contract/CABSYY5FZGCCZ3UTBQGC7S357D2FUFLUQUUGJCCFHKGEJZVIFK4SIS2Z |
| WASM hash | `fc5ce8b84beda9552300368069ac1b530d3384fe917173cfa8505cad0cfeb994` |
| Deploy tx | https://stellar.expert/explorer/testnet/tx/42e2c6aedc39327af97d399fcecfd8ecc95dd63d273fe25a788acd9229b08b56 |
| Source commit | `a34fb88` (Phase E1: `create_escrow` + `get_status`) |

Deployed with the `stellar` CLI (v28.0.0) from a wasm build of
`contracts/escrow` (`cargo build --target wasm32v1-none --release`).

### Verified live, on this deployment

- `get_status` on a nonexistent escrow id correctly returns `Error(Contract, #1)`
  (`Error::NotFound`) rather than succeeding or panicking.
- `create_escrow` with native testnet XLM as the token: a real transfer of
  5,000,000 stroops (0.5 XLM) from payer to the contract, escrow id `0`
  returned — [tx](https://stellar.expert/explorer/testnet/tx/2277d5ca6757e520527ef2d3eda786820e6c1da999df5e725eb0f7b3526d5809).
- `get_status(0)` on that escrow returns `"Funded"`, confirmed via a
  read-only simulation against the live contract.

### Not covered by this deployment

`release`/`refund` aren't implemented yet (Phase E2 — [issue #2](https://github.com/DocForum/docforum-escrow/issues/2),
[issue #3](https://github.com/DocForum/docforum-escrow/issues/3)), so the
escrow created above (id `0`) has no way to actually resolve on this
contract version. That's expected, not a bug — this deployment exists to
prove Phase E1 (`create_escrow`/`get_status`) works on a real network, not
to be a production-usable instance. It'll need redeploying once E2 lands.

### Redeploying

```bash
stellar keys generate --network testnet --fund <alias>   # once, or reuse an existing funded identity
cargo build --target wasm32v1-none --release
stellar contract deploy \
  --wasm target/wasm32v1-none/release/docforum_escrow.wasm \
  --source <alias> \
  --network testnet \
  --alias docforum-escrow
```

Mainnet is explicitly out of scope until the Phase E4 security review is
complete — see [hard rule 4](../ARCHITECTURE_ESSENTIALS.md#hard-rules).
