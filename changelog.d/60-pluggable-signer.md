Issue #60 (Phase E6): added the SDK-owned `Signer` interface with
`KeypairSigner` and a small `RemoteSigner` HTTP adapter. Existing `Keypair`
and SEP-43 signer call sites remain supported, and the configured network
passphrase is forwarded to pluggable signing calls. No contract change.
