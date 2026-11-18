import { EscrowClient, Keypair } from "@docforum/escrow-sdk";

// Keep both public exports live so Vite has to resolve and bundle the SDK's
// browser entrypoint and its Stellar SDK dependencies.
window.docforumEscrowSdkSmoke = { EscrowClient, Keypair };
