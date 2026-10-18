import {
  Address,
  scValToNative,
  type xdr,
} from "@stellar/stellar-sdk";
import { AssembledTransaction } from "@stellar/stellar-sdk/contract";
import { Server, type Api } from "@stellar/stellar-sdk/rpc";

const TESTNET_RPC_URL = "https://soroban-testnet.stellar.org";
const TESTNET_NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
const EVENT_PAGE_SIZE = 10_000;

export interface CheckSolvencyOptions {
  contractId: string;
  tokens: string[];
  /** Defaults to the Soroban testnet RPC endpoint. */
  rpcUrl?: string;
  /** Defaults to the Stellar testnet passphrase. */
  networkPassphrase?: string;
}

export interface TokenSolvency {
  token: string;
  balance: bigint;
  liabilities: bigint;
  shortfall: bigint;
  solvent: boolean;
  /** False when RPC retention prevents proving that all escrows were seen. */
  complete: boolean;
}

export interface SolvencyReport {
  contractId: string;
  checkedThroughLedger: number;
  eventHistoryStartsAtLedger: number;
  tokens: TokenSolvency[];
}

export type SolvencyEvent = {
  kind: "created" | "released" | "refunded";
  escrowId: bigint;
  token: string;
  amount: bigint;
};

/** Pure event reconciliation, exported to make fixture-based checks straightforward. */
export function reconcileSolvencyEvents(
  events: SolvencyEvent[],
  tokenBalances: Map<string, bigint>,
  requestedTokens: string[],
): TokenSolvency[] {
  const escrows = new Map<bigint, { token: string; amount: bigint; active: boolean }>();
  const unique = new Set<string>();
  for (const event of events) {
    // Event IDs are supplied by the RPC layer; fixture callers can use the
    // deterministic tuple below by omitting duplicate event objects entirely.
    const id = `${event.kind}:${event.escrowId}:${event.token}:${event.amount}`;
    if (unique.has(id)) continue;
    unique.add(id);

    if (event.kind === "created") {
      if (escrows.has(event.escrowId)) throw new Error(`Duplicate creation event for escrow ${event.escrowId}`);
      escrows.set(event.escrowId, { token: event.token, amount: event.amount, active: true });
      continue;
    }

    const escrow = escrows.get(event.escrowId);
    if (!escrow) throw new Error(`Settlement event has no creation event for escrow ${event.escrowId}`);
    if (escrow.token !== event.token || escrow.amount !== event.amount) {
      throw new Error(`Settlement event does not match escrow ${event.escrowId}`);
    }
    escrow.active = false;
  }

  return requestedTokens.map((token) => {
    const balance = tokenBalances.get(token);
    if (balance === undefined) throw new Error(`Missing balance for token ${token}`);
    const liabilities = [...escrows.values()].reduce(
      (sum, escrow) => sum + (escrow.active && escrow.token === token ? escrow.amount : 0n),
      0n,
    );
    const shortfall = liabilities > balance ? liabilities - balance : 0n;
    return { token, balance, liabilities, shortfall, solvent: shortfall === 0n, complete: true };
  });
}

function decodeLifecycleEvent(event: Api.EventResponse): SolvencyEvent | undefined {
  const eventName = scValToNative(event.topic[0] as xdr.ScVal);
  if (eventName !== "EscrowCreated" && eventName !== "EscrowReleased" && eventName !== "EscrowRefunded") {
    return undefined;
  }
  const escrowId = scValToNative(event.topic[1] as xdr.ScVal);
  const value = scValToNative(event.value as xdr.ScVal) as Record<string, unknown>;
  const token = value.token;
  const amount = value.amount;
  if (typeof escrowId !== "bigint" || typeof token !== "string" || typeof amount !== "bigint") {
    throw new Error(`Malformed ${eventName} lifecycle event (${event.id})`);
  }
  return {
    kind: eventName === "EscrowCreated" ? "created" : eventName === "EscrowReleased" ? "released" : "refunded",
    escrowId,
    token,
    amount,
  };
}

async function fetchEvents(server: Server, contractId: string, oldestLedger: number, latestLedger: number): Promise<Api.EventResponse[]> {
  const events: Api.EventResponse[] = [];
  let page = await server.getEvents({
    startLedger: oldestLedger,
    endLedger: latestLedger + 1,
    limit: EVENT_PAGE_SIZE,
    filters: [{ type: "contract", contractIds: [contractId] }],
  });
  events.push(...page.events);
  while (page.events.length === EVENT_PAGE_SIZE && page.cursor) {
    page = await server.getEvents({ cursor: page.cursor, limit: EVENT_PAGE_SIZE, filters: [{ type: "contract", contractIds: [contractId] }] });
    events.push(...page.events);
  }
  return events;
}

async function readTokenBalance(token: string, contractId: string, rpcUrl: string, networkPassphrase: string): Promise<bigint> {
  const tx = await AssembledTransaction.build({
    method: "balance",
    args: [Address.fromString(contractId).toScVal()],
    contractId: token,
    rpcUrl,
    networkPassphrase,
    parseResultXdr: (result) => scValToNative(result),
  });
  const balance = tx.result.unwrap();
  if (typeof balance !== "bigint") throw new Error(`Token ${token} returned a non-integer balance`);
  return balance;
}

/**
 * Read the escrow contract's token balances and reconstruct outstanding
 * amounts from its lifecycle events. Soroban RPC retains a bounded event
 * window; this report marks itself incomplete unless creation event 0 is
 * available, so callers can distinguish a clean result from a partial scan.
 */
export async function checkSolvency(options: CheckSolvencyOptions): Promise<SolvencyReport> {
  if (!options.contractId) throw new Error("contractId is required");
  if (options.tokens.length === 0) throw new Error("At least one token address is required");
  const rpcUrl = options.rpcUrl ?? TESTNET_RPC_URL;
  const networkPassphrase = options.networkPassphrase ?? TESTNET_NETWORK_PASSPHRASE;
  const server = new Server(rpcUrl);
  const health = await server.getHealth();
  const rawEvents = await fetchEvents(server, options.contractId, health.oldestLedger, health.latestLedger);
  const seenIds = new Set<string>();
  const decodedEvents: SolvencyEvent[] = [];
  for (const event of rawEvents) {
    if (seenIds.has(event.id)) continue;
    seenIds.add(event.id);
    const decoded = decodeLifecycleEvent(event);
    if (decoded) decodedEvents.push(decoded);
  }

  const balances = new Map<string, bigint>();
  for (const token of options.tokens) {
    balances.set(token, await readTokenBalance(token, options.contractId, rpcUrl, networkPassphrase));
  }
  const createdIds = new Set(decodedEvents.filter((event) => event.kind === "created").map((event) => event.escrowId));
  const orphanedSettlements = decodedEvents.some((event) => event.kind !== "created" && !createdIds.has(event.escrowId));
  const createdIdList = [...createdIds].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const contiguousIds = createdIdList.every((id, index) => id === BigInt(index));
  const historyComplete = !orphanedSettlements && createdIdList.length > 0 && contiguousIds;
  // A settlement whose creation fell outside RPC retention carries no
  // outstanding liability, so omit that orphan event while marking the
  // resulting report incomplete.
  const eventsWithCreation = decodedEvents.filter((event) => event.kind === "created" || createdIds.has(event.escrowId));
  const results = reconcileSolvencyEvents(eventsWithCreation, balances, options.tokens);
  return {
    contractId: options.contractId,
    checkedThroughLedger: health.latestLedger,
    eventHistoryStartsAtLedger: health.oldestLedger,
    tokens: results.map((result) => ({ ...result, complete: historyComplete })),
  };
}
