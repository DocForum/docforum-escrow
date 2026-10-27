import assert from "node:assert/strict";
import { EscrowClient, Keypair } from "../dist/esm/index.js";

const signer = Keypair.random();
assert.match(signer.publicKey(), /^G[A-Z2-7]{55}$/);

const client = new EscrowClient({
  contractId: signer.publicKey(),
  rpcUrl: "https://127.0.0.1:1",
});
assert.ok(client);

console.log("SDK runtime smoke test passed (no network requests made).");
