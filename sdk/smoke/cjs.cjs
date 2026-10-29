const assert = require("node:assert/strict");
const sdk = require("@docforum/escrow-sdk");

assert.equal(typeof sdk.EscrowClient, "function");
assert.equal(typeof sdk.Keypair.fromSecret, "function");
console.log("CJS package entrypoint loaded");
