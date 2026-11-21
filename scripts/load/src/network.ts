// Local-network plumbing: RPC readiness, Friendbot funding.
import { rpc } from "@stellar/stellar-sdk";
// Keypair comes from the SDK package rather than a second copy of
// @stellar/stellar-sdk, so the `Keypair` instances this harness creates are
// the exact type `EscrowClient`/`ChannelAccountPool` accept.
import { Keypair } from "@docforum/escrow-sdk";

export function makeServer(rpcUrl: string): rpc.Server {
  return new rpc.Server(rpcUrl, { allowHttp: true });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait until the local RPC answers `getLatestLedger`. */
export async function waitForRpc(server: rpc.Server, timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await server.getLatestLedger();
      return;
    } catch (error) {
      lastError = error;
      await sleep(2_000);
    }
  }
  throw new Error(`Local Soroban RPC did not become ready within ${timeoutMs}ms: ${String(lastError)}`);
}

/** Fund a fresh account from the local Friendbot (creates it). */
export async function fundAccount(
  friendbotUrl: string,
  publicKey: string,
  attempts = 5,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(`${friendbotUrl}?addr=${encodeURIComponent(publicKey)}`);
      if (!response.ok) {
        throw new Error(`${response.status} ${await response.text()}`);
      }
      return;
    } catch (error) {
      lastError = error;
      await sleep(attempt * 1_000);
    }
  }
  throw new Error(`Friendbot could not fund ${publicKey}: ${String(lastError)}`);
}

/** Generate and fund `count` fresh keypairs, in parallel. */
export async function createFundedKeypairs(
  friendbotUrl: string,
  count: number,
): Promise<Keypair[]> {
  const keypairs = Array.from({ length: count }, () => Keypair.random());
  await Promise.all(keypairs.map((keypair) => fundAccount(friendbotUrl, keypair.publicKey())));
  return keypairs;
}

/** Wait until every account is visible to the RPC (Friendbot is async). */
export async function waitForAccounts(
  server: rpc.Server,
  publicKeys: string[],
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const pending = new Set(publicKeys);
  while (pending.size > 0 && Date.now() < deadline) {
    for (const publicKey of [...pending]) {
      try {
        await server.getAccount(publicKey);
        pending.delete(publicKey);
      } catch {
        // Not visible yet — retry on the next pass.
      }
    }
    if (pending.size > 0) await sleep(1_000);
  }
  if (pending.size > 0) {
    throw new Error(`${pending.size} funded account(s) never appeared on the local ledger`);
  }
}
