---
file: README.md
section: TypeScript SDK surface (`sdk/`)
---

### GitHub Action

The reusable [`action/`](action) runs `create`, `release`, `refund`, and
`status` modes with the SDK. It defaults to Stellar testnet, masks the signer
secret, rejects mainnet configuration, and refuses fork-origin `pull_request`
events before reading secrets. See [the testnet example workflow](.github/workflows/escrow-action-testnet.yml).
