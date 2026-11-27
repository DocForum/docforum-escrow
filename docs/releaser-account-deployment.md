# Deploying the releaser custom account

`scripts/deploy-releaser-account` deploys the optional M-of-N custom releaser
account (`contracts/releaser-account/`, ADR 0005) from a reviewed config file.
The account's security is its constructor, so the script validates the config
before any network call, deploys with the pinned Stellar CLI, reads every
constructor argument back from the contract, and records the result next to
`deployments.json`. Testnet (or a local quickstart) only: mainnet is refused
until ROADMAP.md Phase E4's security review is done.

## Usage

```bash
# Build, deploy to testnet, verify the read-back and record the deployment.
scripts/deploy-releaser-account --config examples/releaser-account/deploy-config.example.json

# Same flow against a local quickstart; prints the record, writes no files.
scripts/deploy-releaser-account --config my-config.json --dry-run

# Deploy an already-built WASM and pin its hash.
scripts/deploy-releaser-account --config my-config.json \
  --wasm contracts/releaser-account/target/wasm32v1-none/release/docforum_releaser_account.wasm \
  --expected-wasm-hash <sha256>
```

The script refuses a dirty git tree (the recorded `gitSha` must be the source
it deployed), the wrong Stellar CLI version, and any network other than
`testnet`/`local`. `--no-record` deploys and verifies without writing a record.

## Config format

The config is plain JSON, reviewed like code, and must contain exactly these
keys:

```json
{
  "escrow": "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
  "signers": [
    "1f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100",
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
  ],
  "threshold": 2,
  "max_operations_per_window": 100,
  "window_ledgers": 17280
}
```

| Key | Meaning | Rule |
|---|---|---|
| `escrow` | The one escrow contract this account may settle | 56-character contract id (`C...`) |
| `signers` | Ed25519 public keys of the M-of-N quorum | 1–20 distinct keys, 64 hex or `G...` strkey |
| `threshold` | Signatures required per operation | 1 to `signers.length` |
| `max_operations_per_window` | Rate-limit cap | Integer ≥ 1 |
| `window_ledgers` | Length of the rate-limit window | Integer ≥ 1 and below the network's `max_ttl` (6,312,000 ledgers) |

Validation happens before any RPC call:

- Unknown keys, missing keys, duplicates (including the same key given as hex
  and as a `G...` strkey) and out-of-range values are rejected.
- Only public keys are accepted. Secret keys (`S...` seeds) and keys named
  `secret`, `seed` or `private` are refused everywhere in the file.
- `G...` public-key strkeys are decoded (checksum checked) and stored as
  lowercase hex, which is what the constructor takes.
- Signers are sorted, so listing the same keys in a different order produces
  the same config hash.

The config hash is SHA-256 over canonical JSON: sorted object keys, sorted
signers, no whitespace. Print it with:

```bash
node scripts/releaser-account-config.mjs hash my-config.json
```

## Read-back verification

After deploying, the script calls the account's own getters and fails on any
mismatch with the config:

| Constructor argument | Read back with | Compared with |
|---|---|---|
| `escrow` | `escrow()` | config `escrow` |
| `signers` | `signer_count()` | `signers.length` |
| `threshold` | `threshold()` | config `threshold` |
| `max_operations_per_window` | `policy()` | config `max_operations_per_window` |
| `window_ledgers` | `policy()` | config `window_ledgers` |

It also fetches the deployed WASM and compares its SHA-256 with the uploaded
hash. No record is written unless every check passes. `signer_count()` is the
only signer-side read the contract exposes; each individual key is verified by
the deployment's constructor validation (duplicates and bad keys are rejected
on-chain) and by the recorded config hash.

## Record format

Successful testnet deployments are appended to
`releaser-account-deployments.json` (`{ "version": 1, "deployments": [...] }`),
newest last, atomically:

```json
{
  "network": "testnet",
  "networkPassphrase": "Test SDF Network ; September 2015",
  "rpcUrl": "https://soroban-testnet.stellar.org",
  "escrow": "C...",
  "accountId": "C...",
  "wasmHash": "<sha256 of the deployed WASM>",
  "configHash": "<sha256 of the canonical config>",
  "config": { "escrow": "C...", "signers": ["<hex>"], "threshold": 2,
              "max_operations_per_window": 100, "window_ledgers": 17280 },
  "threshold": 2,
  "signerCount": 2,
  "policy": { "maxOperationsPerWindow": 100, "windowLedgers": 17280 },
  "gitSha": "<commit the WASM was built from>",
  "deployedAt": "<ISO-8601 timestamp>",
  "uploadTxHash": "<hash or null when the WASM was already on the network>",
  "deployTxHash": "<deployment transaction hash>",
  "explorer": { "contract": "https://stellar.expert/explorer/testnet/contract/C...",
                "tx": "https://stellar.expert/explorer/testnet/tx/" }
}
```

`config` is the normalised config (sorted lowercase-hex signers), so anyone
can recompute `configHash` from the record and compare it with the reviewed
file. Local (dry-run) deployments are never recorded. Re-recording the same
`accountId` on the same network is refused.
