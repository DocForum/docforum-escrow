# Testnet deployments

> **Automated deployments:** testnet deployments can be run from GitHub
> Actions via the manually dispatched **Testnet Deploy** workflow
> (`.github/workflows/testnet-deploy.yml`). It runs `scripts/deploy-testnet.sh`
> from a selected ref using a dedicated deployer identity scoped to the
> `testnet` environment (required reviewers), then opens a PR updating this
> file and `deployments.json`. See the workflow header for the required
> secrets and inputs. Entries below are recorded manually or by that workflow.

## `docforum_escrow` — 2026-10-20 (latest upstream main at `80ce157`, issue #109)

| | |
|---|---|
| Network | Stellar Testnet (`Test SDF Network ; September 2015`) |
| Contract ID | `CAFI5QOTNLK5OIHEHGGQ7B22RN5IUOFGKKEID2OQCZSCJAQS4FLSS2DR` |
| Explorer | https://stellar.expert/explorer/testnet/contract/CAFI5QOTNLK5OIHEHGGQ7B22RN5IUOFGKKEID2OQCZSCJAQS4FLSS2DR |
| WASM hash | `a7cc9cd2db750d9fe8fee4c708cd2b0d6c2d5cf2d1e27c4446550b317957a9b6` |
| WASM upload tx | https://stellar.expert/explorer/testnet/tx/275d6326a1d086a1a335d1a58cf81670156fb213f80360acf7c08ce389d34a2e |
| Deploy tx | https://stellar.expert/explorer/testnet/tx/e034ebce6efb51f9e81188790c49d37bfb54cafc908cd61af58d9759ccd3e314 |
| Source commit | `80ce157` (upstream main, sponsored funding with `refund_to`) |

This supersedes the 2026-10-20 deployment immediately below. The
constructor allowlist contains the testnet native XLM SAC
`CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` and the
fee-on-transfer test token recorded in the deployment history. The
`EscrowData` layout and creation methods include the optional `refund_to`
destination from ADR 0009. Earlier deployment entries remain as history.

### Live lifecycle verification

All listed transactions ran against the contract above. The read-only
`get_status` queries returned the recorded statuses shown here.

- Create escrow 0 (1,000,000 stroops):
  [transaction](https://stellar.expert/explorer/testnet/tx/699440d275b8d348cd9d267d10e57332c21b4afdcc0b6ad8e775ff599d97d883).
- Release escrow 0:
  [transaction](https://stellar.expert/explorer/testnet/tx/9b5a8de4a2147c37c51d9a015c8a807a6e7b6a27fff8f820404e660f767e64e2);
  `get_status(0)` returned `Released`.
- Create escrow 1:
  [transaction](https://stellar.expert/explorer/testnet/tx/516cdbd8a9e7088e9604ff979a30af91eb3d5af8de023b02726e722219508381).
- Refund escrow 1:
  [transaction](https://stellar.expert/explorer/testnet/tx/828195f5c356bef2754babbc261137b5a70c0332231bc9c7a30831396e94a198);
  `get_status(1)` returned `Refunded`.
- Create timeout escrow 2 with `refund_after` = `1792526906`:
  [transaction](https://stellar.expert/explorer/testnet/tx/b43741dbea36afccad43fa9538a2d8565b016831422acb3777c81537708ba6b).
- Stranger timeout-refund escrow 2 after its deadline:
  [transaction](https://stellar.expert/explorer/testnet/tx/d4b37192cb5f99588a060cd7fd05a46d9b0dfc38f468fa2a9df3147037bea907);
  `get_status(2)` returned `Refunded`.

### BalanceMismatch test token

The token was funded and simulated with its fee disabled, then a 10%
transfer fee was enabled before submitting the prepared transaction. The
contract rejected that real testnet transaction with `BalanceMismatch`
(error code 6):
[failed transaction](https://stellar.expert/explorer/testnet/tx/340815ee6366f19c456b5402a6af28892c00f4bfb0875102e0e548f000191770).
The 10% fee was enabled after simulation in
[this transaction](https://stellar.expert/explorer/testnet/tx/faaeddeba9ec0817ce7e41e370fa2ca18d00d3ff75ee4c6a6e3ba65cc63b1802).

## `docforum_escrow` — 2026-10-20 (upstream main at `01fb243`, issue #109)

| | |
|---|---|
| Network | Stellar Testnet (`Test SDF Network ; September 2015`) |
| Contract ID | `CBJNXW726ALRGQEWERZ6UEVWICRLB36HAVP6WQPFXTDB4N67BXMYSK7P` |
| Explorer | https://stellar.expert/explorer/testnet/contract/CBJNXW726ALRGQEWERZ6UEVWICRLB36HAVP6WQPFXTDB4N67BXMYSK7P |
| WASM hash | `e8685a53143cf276f7b0519b6e768a162860d7d8212c26e626679d7abac48adc` |
| WASM upload tx | https://stellar.expert/explorer/testnet/tx/44e1935336cecbafebd0aa9a5208ce1dc1344094360c3ec1bb1a9e9b66f8e1e2 |
| Deploy tx | https://stellar.expert/explorer/testnet/tx/47db5beefc7d4cb3699a99b8eb63b7543e4d6e6ae3b5b6e3788d6c82ee5d05af |
| Source commit | `01fb243` (upstream main, including payee acceptance) |

This supersedes the pre-acceptance 2026-10-20 deployment immediately
below and the 2026-10-08 deployment. The constructor allowlist contains
the testnet native XLM SAC
`CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` and the test
token below. The latest `EscrowData` layout includes opt-in payee
acceptance. Prior records are retained as history.

### BalanceMismatch test token

The test-only token was configured to charge a 10% transfer fee after
simulation. The latest contract rejected the funded-escrow attempt on
chain with `BalanceMismatch` (error code 6):
[failed transaction](https://stellar.expert/explorer/testnet/tx/120d0f3a1829f98a2f48a733f0ac65f4f42fea7826823c4ff26154ca4586b75d).
The fee was enabled in
[this transaction](https://stellar.expert/explorer/testnet/tx/241cb4a1573b82b31933f4f66d6a7480a1890fe3bab46dcca05b33eabeb28217).
The token contract and WASM deployment details are recorded in the
following 2026-10-20 deployment history entry.

### Live lifecycle verification

All entries are real testnet transactions against the contract above.

- Create escrow 0 (1,000,000 stroops):
  [transaction](https://stellar.expert/explorer/testnet/tx/a93dd2d4fcb8c74f342ea44f63402e1cc2a8ca79b90429dc0bf6d450f944f237).
- Release escrow 0:
  [transaction](https://stellar.expert/explorer/testnet/tx/2992f61981e7f986b3fcbc88767b3e6388ad207b81a3f0336ca642fad730d0e9);
  `get_status(0)` returned `Released`.
- Create escrow 1:
  [transaction](https://stellar.expert/explorer/testnet/tx/1d64163db44c8349d97156cd27f0848cd8feeb77dd1d6fc699b5f3f385b64d0c).
- Refund escrow 1:
  [transaction](https://stellar.expert/explorer/testnet/tx/79df0d2418f340e6b85b6e5ce9eaedbe237e51441bd6a10e774c87623fdecc04);
  `get_status(1)` returned `Refunded`.
- Create timeout escrow 2 with `refund_after` = `1792501856`:
  [transaction](https://stellar.expert/explorer/testnet/tx/5524d72aa1c491a466d6ae0f06f4189ec0d98b56975434e07c578574e49dd61b).
- Stranger timeout-refund escrow 2 after its deadline:
  [transaction](https://stellar.expert/explorer/testnet/tx/e7f133ecae859604cb34b8a8a9ad651f23a76e282f9d36255b696566e81ce7f7);
  `get_status(2)` returned `Refunded`.

## `docforum_escrow` — 2026-10-20 (pre-acceptance deployment, source `42d9d4e`)

| | |
|---|---|
| Network | Stellar Testnet (`Test SDF Network ; September 2015`) |
| Contract ID | `CBTVRRDDT66D4PIVX5OKQVHXEHZ736IQK6CQGLIZ5B77EXLC4F6L4OD2` |
| Explorer | https://stellar.expert/explorer/testnet/contract/CBTVRRDDT66D4PIVX5OKQVHXEHZ736IQK6CQGLIZ5B77EXLC4F6L4OD2 |
| WASM hash | `4ad9535939a1effbc8d5d5fce11e88a0f6b8e4d84d49654ffb65215dec60ad04` |
| WASM upload tx | https://stellar.expert/explorer/testnet/tx/5204185c776327ffd6291346571a7d0db34b6d8cf1b6e1c5fed0f1c5da2047fd |
| Deploy tx | https://stellar.expert/explorer/testnet/tx/6dcef4aea2f20f391f60b8652c4425d007ba89f0bbbda49f5f31f3ff6053fbda |
| Source commit | `42d9d4e` (main at deployment) |

This supersedes the 2026-10-08 deployment below. The constructor allowlist
contains the testnet native XLM SAC
`CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` and the test
token below. This build includes the balance-delta check (issue #12),
M-of-N quorum, callback support, and the current `EscrowData` layout.

### Test token used for `BalanceMismatch`

| | |
|---|---|
| Contract ID | `CDBYIWYH4JFECDYGKVUV2WLSI3YNLWZTN76EEL4NFHJPRDEHWSVF3EWW` |
| WASM hash | `8d0a8eb891cb5678a8dd8c1b7b084e5e44d94158983b5ad4a61f0f9b54cef96c` |
| WASM upload tx | https://stellar.expert/explorer/testnet/tx/ae60b3490bacac373ee2d1ec9ad268cffb1d8e822fd9f2f7b5a6223e12dd2863 |
| Deploy tx | https://stellar.expert/explorer/testnet/tx/306f126cf1d8902fe56bf166375b31f8956606a977eb9dcbeb9c7a47edffd33e |

The test-only token owner enabled a 10% transfer fee after transaction
simulation, then submitted the previously prepared `create_escrow`. The
included transaction failed with `BalanceMismatch` (contract error 6):
[failed transaction](https://stellar.expert/explorer/testnet/tx/6cbdd3f51f228b05576c5ef7b6658a721226b33c7511052446c08c461b9e9248).
The token was configured with a fee in
[this transaction](https://stellar.expert/explorer/testnet/tx/628891be60f1d47e8237afcf8cfc4df8d487d502c8a4723c85a47f91d9d380d9).

### Live lifecycle verification

Each link is a real testnet transaction against the contract above.

- Create escrow 3 (1,000,000 stroops):
  [transaction](https://stellar.expert/explorer/testnet/tx/bd1c168f7f3708370f489e2814f8874997c45bfa7076ef153acec248ca782fdf).
- Release escrow 3:
  [transaction](https://stellar.expert/explorer/testnet/tx/02d6f7eaed1d0f30a0696c2457f18f93bd304af1264d43b0be896b7db2114255);
  `get_status(3)` returned `Released`.
- Create escrow 4:
  [transaction](https://stellar.expert/explorer/testnet/tx/be2373eb464efb78af2980a3d3a36c0c347df68e5fb0d4cf3df7402c6b1157d6).
- Refund escrow 4:
  [transaction](https://stellar.expert/explorer/testnet/tx/0d51f0be85be38391bc03c36d0bc9360393adc9b604631257e1041202b95c8ff);
  `get_status(4)` returned `Refunded`.
- Create timeout escrow 5:
  [transaction](https://stellar.expert/explorer/testnet/tx/9bcd8ca7049a267694b5d855139faf4a01b8f51055b123dda0242ed603f80973).
- Stranger timeout-refund of escrow 5 after its deadline:
  [transaction](https://stellar.expert/explorer/testnet/tx/aa24945aa528a7c2f86acd6e805834d738b2160fdce3d364d3ae22728fc9d5a2);
  `get_status(5)` returned `Refunded`.

An earlier preliminary escrow instance (`CCZTMUUOKRGAHAAJL7AHUYYU5VNNNDHCRTRBF2LDQJICXUJXLJOXY7AO`, deploy tx
`2bb89239dfd0a89698d2b0e7cc1e61a549df3ab437e2abb56871a05f2017b824`)
and a fixed-fee test token were superseded during verification; the
contract and test-token records above are the final verified pair. The
2026-10-08 deployment remains below as historical record.

## `docforum_escrow` — 2026-10-08 (Phase E4: `refund_after` timeout refund + `get_escrow`)

| | |
|---|---|
| Network | Stellar Testnet (`Test SDF Network ; September 2015`) |
| Contract ID | `CAHQ4J3T23WSIBBG6SI6EAYR5Q2HIPKG5YMC4SMZBOTYA6MYK2VADEV5` |
| Explorer | https://stellar.expert/explorer/testnet/contract/CAHQ4J3T23WSIBBG6SI6EAYR5Q2HIPKG5YMC4SMZBOTYA6MYK2VADEV5 |
| WASM hash | `1d23862ac7b6671959946b06f6ffdb5115938abb1974486db61aeeebefc78327` |
| Deploy tx | https://stellar.expert/explorer/testnet/tx/16880a10f71fcea8cb1f1b7b0ed83e1f115d434c06f3d1e3cd7a6692b513edae |
| Source commit | `7a595d8` (Phase E4 / issue #11: `refund_after` timeout refund + `get_escrow` — see `docs/adr/0004`) |

This **supersedes** the 2026-09-15 deployment below — `create_escrow`'s
signature changed (added `refund_after: Option<u64>`) and `EscrowData`'s
layout changed, so the old contract ID is no longer signature- or
layout-compatible with the current contract source. The prior entries
are kept as accurate history, not deleted.

### Verified live, on this deployment

Every claim below is a real transaction or a real contract error
observed on-chain, not just a local test assertion. Escrow ids are this
contract's own (`0`–`3`).

- **`create_escrow` id `0`, with a deadline** (`refund_after` =
  1791442266, ~2.5 min out), 1,000,000 stroops (0.1 XLM) —
  [tx](https://stellar.expert/explorer/testnet/tx/b8ee6776f715acbf0ae51ed88e64801f1cd7adfc38f3c38d374f9729366bc181).
  `get_escrow(0)` → `"Funded"`, `"refund_after": 1791442266`.
- **`create_escrow` id `1`, with no deadline** —
  [tx](https://stellar.expert/explorer/testnet/tx/f0495bef2a2f96e9a922b66f7333f9dd9b859f85b5f8a727f558888c998c10f5).
  `get_escrow(1)` → `"refund_after": null`.
- **`create_escrow` id `2`, same deadline as `0`** —
  [tx](https://stellar.expert/explorer/testnet/tx/41dfdeafb62537a3577005707460bc919677dd10c92ff2a7520269e7551d498b).
- **Stranger refund rejected *before* the deadline**: an identity that
  is neither the releaser nor the payer calling `refund(0)` fails with
  `Error(Contract, #3)` (`Error::Unauthorized`) — confirmed via the
  contract's own diagnostic event, before any ledger time reached the
  deadline.
- **Deadline already in the past at creation rejected**: `create_escrow`
  with `refund_after` = now − 60s fails with `Error(Contract, #5)`
  (`Error::InvalidRefundAfter`), and no funds were pulled from the payer.
- **No deadline ⇒ no timeout**: the same stranger calling `refund(1)`
  (which has no `refund_after`) fails with `Error(Contract, #3)` even
  long after any deadline would have passed.
- **Releaser refund before its deadline still works**: `refund(3)` by
  the designated releaser, with `refund_after` in the future —
  [tx](https://stellar.expert/explorer/testnet/tx/53072a66f1b9aa2410de04a2cf3645a490d18ca4db67c7c5ad3e1d84fae0ce67).
  `get_status(3)` → `"Refunded"`.
- **Timeout refund by a non-releaser *after* the deadline** (the new
  path, issue #11): the same stranger identity calling `refund(0)` once
  the ledger close time passed 1791442266 succeeds —
  [tx](https://stellar.expert/explorer/testnet/tx/d1c8ef6379f75db328530ed93a3a668cf302b3eea3c08d5abe841ca998577ce3).
  `get_status(0)` → `"Refunded"`.
- **Second refund on the settled escrow rejected**: `refund(0)` again
  fails with `Error(Contract, #4)` (`Error::NotFunded`) — the timeout
  path cannot pay out twice (invariant I3).
- **`release` after the deadline still works**: `release(2)` by the
  releaser, after the same deadline had passed —
  [tx](https://stellar.expert/explorer/testnet/tx/735c1cd5375f9e14769f9389c4e8b1af940abe24e7495cbc4b2631ae26a2c65b).
  `get_status(2)` → `"Released"`.
- **Funds went where the contract says**: afterwards the contract
  account held exactly **1,000,000 stroops** — only escrow `1`, the one
  still `Funded`. The payee received the 1,000,000 from the release; the
  identity that triggered the timeout refund received **nothing** (it
  only paid fees) — the refund landed on the payer, as ADR 0004
  requires.
- **SDK integration suite**: all 5 tests in
  `sdk/tests/testnet-integration.test.ts` pass against this contract id
  (`npm run test:integration`) — release lifecycle, refund lifecycle,
  unauthorized-caller rejection, deadline surfacing via `getEscrow`, and
  rejection of an already-past `refundAfter`.

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

Remember the SDK's tests and any consumer config (`contractId`) point at
the id above — a redeploy means updating those, not just this file.

Mainnet is explicitly out of scope until the Phase E4 security review is
complete — see [hard rule 4](../ARCHITECTURE_ESSENTIALS.md#hard-rules).

---

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
