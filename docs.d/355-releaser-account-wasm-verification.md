---
file: README.md
section: Verify this deployment
---

### Verify a deployed releaser account

Each `contract-v*` GitHub release publishes `docforum_releaser_account.wasm`
and `docforum_releaser_account.wasm.sha256`. Download both from the
[repository's Releases](https://github.com/DocForum/docforum-escrow/releases)
and verify the downloaded file:

```bash
sha256sum -c docforum_releaser_account.wasm.sha256
```

A deployed releaser account has a contract address distinct from the escrow
contract it is configured to authorize. Fetch the WASM for the deployed
account and compare its SHA-256 with the release asset:

```bash
stellar contract fetch --id "$RELEASER_ACCOUNT_ID" \
  --rpc-url https://soroban-testnet.stellar.org \
  --network-passphrase 'Test SDF Network ; September 2015' \
  --out-file deployed_releaser_account.wasm
sha256sum deployed_releaser_account.wasm docforum_releaser_account.wasm
```

The checksum file verifies the bytes downloaded from GitHub; the fetched
on-chain WASM hash identifies the code used by that deployed account. They
should match when that account was deployed from the published artifact. Then
inspect its immutable escrow target and current quorum/policy settings with the
read-only views `escrow`, `threshold`, `signer_count`, and `policy`. For
example, with a Stellar CLI source alias configured for your testnet:

```bash
stellar contract invoke --send=no --id "$RELEASER_ACCOUNT_ID" \
  --source "$SOURCE_ACCOUNT" --rpc-url https://soroban-testnet.stellar.org \
  --network-passphrase 'Test SDF Network ; September 2015' -- escrow
stellar contract invoke --send=no --id "$RELEASER_ACCOUNT_ID" \
  --source "$SOURCE_ACCOUNT" --rpc-url https://soroban-testnet.stellar.org \
  --network-passphrase 'Test SDF Network ; September 2015' -- threshold
stellar contract invoke --send=no --id "$RELEASER_ACCOUNT_ID" \
  --source "$SOURCE_ACCOUNT" --rpc-url https://soroban-testnet.stellar.org \
  --network-passphrase 'Test SDF Network ; September 2015' -- signer_count
stellar contract invoke --send=no --id "$RELEASER_ACCOUNT_ID" \
  --source "$SOURCE_ACCOUNT" --rpc-url https://soroban-testnet.stellar.org \
  --network-passphrase 'Test SDF Network ; September 2015' -- policy
```

Compare those values with the deployment's independently recorded
configuration. The contract exposes a signer count but no signer-list view, so
verify the signer set against the deployment configuration and its
key-management records.
