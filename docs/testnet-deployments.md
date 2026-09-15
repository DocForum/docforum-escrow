# Testnet deployments

## `docforum_escrow` — 2026-09-15 (Phase E2: adds `release`/`refund`)

| | |
|---|---|
| Network | Stellar Testnet (`Test SDF Network ; September 2015`) |
| Contract ID | `CAXESEEAJILFFCN3PH2HHNMWAAHLEB64UTJHZ6IP7C5BBICT3S3VODSM` |
| Explorer | https://stellar.expert/explorer/testnet/contract/CAXESEEAJILFFCN3PH2HHNMWAAHLEB64UTJHZ6IP7C5BBICT3S3VODSM |
| WASM hash | `8cb78f2a84ebdbfd1a1651e74bd396161eb811c077a4957a75d72e9eb909e9a2` |
| Deploy tx | https://stellar.expert/explorer/testnet/tx/2e0682a216d22d757c3ad99f517994b0471f5802b7a784896f6da5abeda270ff |
| Source commit | `31f41da` (Phase E2: `release` + `refund`, `create_escrow` gains `releaser` param — see `docs/adr/0002`) |

This **supersedes** the 2026-09-14 deployment below — the `create_escrow`
signature changed (added `releaser: Address`), so the old contract ID is
no longer signature-compatible with the current contract source. The old
entry is kept as accurate history, not deleted.

### Verified live, on this deployment

- `create_escrow` (escrow id `0`): payer, payee, native testnet XLM,
  5,000,000 stroops (0.5 XLM), a separate `releaser` identity —
  [tx](https://stellar.expert/explorer/testnet/tx/0efb9218c4c6614805cccf2a34c736ea939f39ef2752bee0ded40578623874d2).
  `get_status(0)` → `"Funded"`.
- `release(0)` called by the designated `releaser`: real transfer event,
  5,000,000 stroops moved from the contract to `payee` —
  [tx](https://stellar.expert/explorer/testnet/tx/1e360de166e8a3aa13cf3c17eb584f9ac29f93e40dabb1bb6e7b0f8eb8ee9ecb).
  `get_status(0)` → `"Released"`.
- **Unauthorized caller rejected live**: `payee` (not the releaser)
  attempting `release(0)` fails with `Error(Contract, #3)`
  (`Error::Unauthorized`) — confirmed via the contract's own diagnostic
  event log, not just a local test assertion.
- `create_escrow` (escrow id `1`): a second escrow, 2,000,000 stroops
  (0.2 XLM) —
  [tx](https://stellar.expert/explorer/testnet/tx/740ab4fcfaa19bc48d3c5959852d81455dbe64a7651c242384970b94a704d7b6).
- `refund(1)` called by the designated `releaser`: real transfer event,
  2,000,000 stroops returned to `payer` —
  [tx](https://stellar.expert/explorer/testnet/tx/5e1e4188df815a22e6092c15680ff342eea1d12eff17eabf32fa5c1eb7033544).
  `get_status(1)` → `"Refunded"`.

This closes the "not yet done" gap noted in `ROADMAP.md`'s Phase E2 entry
— release/refund are now proven on a real network, not just the local
test suite.

---

## `docforum_escrow` — 2026-09-14 (superseded — see above)

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
