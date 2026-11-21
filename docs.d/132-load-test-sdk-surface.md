---
file: ARCHITECTURE_ESSENTIALS.md
after: "client.mergeSignatures([signedXdr, ...]);"
---

// Channel accounts (issue #132): one in-flight transaction per source key.
// Used by scripts/load/ and exported for integrators doing volume.
import { ChannelAccountPool } from "@docforum/escrow-sdk";
const pool = new ChannelAccountPool(channelKeypairs);
await pool.run(async (channel) => client.createEscrow({ payer: channel, releaser: channel.publicKey(), ... }));
