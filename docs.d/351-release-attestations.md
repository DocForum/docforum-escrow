---
file: README.md
section: Verify this deployment
---
Every `contract-v*` release WASM also carries a GitHub artifact attestation
(Sigstore-backed build provenance), which ties the published bytes to the
workflow run and commit that built them. After downloading the file, verify it
with the GitHub CLI:

```bash
gh attestation verify docforum_escrow.wasm -R DocForum/docforum-escrow
```

The SDK tarball attached to an `sdf-v*` release is attested the same way;
verify it with `gh attestation verify docforum-escrow-sdk-<version>.tgz -R
DocForum/docforum-escrow`. `sha256sum -c` still detects corruption in transit;
the attestation answers where the bytes came from.
