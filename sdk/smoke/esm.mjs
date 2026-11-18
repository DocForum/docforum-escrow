import assert from "node:assert/strict";
import { EscrowClient, Keypair } from "@docforum/escrow-sdk";

assert.equal(typeof EscrowClient, "function");
assert.equal(typeof Keypair.fromSecret, "function");
console.log("ESM package entrypoint loaded");
