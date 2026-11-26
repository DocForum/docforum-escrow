Issue #351 (Phase E7): `contract-v*` and `sdf-v*` releases now carry
Sigstore-backed GitHub build-provenance attestations for the WASM (and its
SHA-256 file's subject) and for the packed SDK tarball, so
`gh attestation verify <file> -R DocForum/docforum-escrow` ties the published
bytes to the workflow run that built them. Both release workflows add the
attestation step with the pinned `actions/attest-build-provenance` action, and
their permissions stay scoped to the single job that needs
`id-token: write`/`attestations: write`. The README's verification section is
extended by a `docs.d/` fragment.
