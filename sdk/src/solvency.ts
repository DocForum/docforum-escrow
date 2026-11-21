// Solvency checker (issue #78, Phase E6).
//
// A clawback-enabled token can remove funds from the shared pool after
// creation (threat model T5) and nothing was watching for it. `checkSolvency`
// compares the contract's balance with what it owes, per token, so an
// integrator can alert before payouts start failing.
//
// Primary path: the on-chain `solvency` view (issue #39), one call per token
// through `client.getSolvency`. If the deployment predates that view, the
// liabilities are rebuilt from events instead: every `created` event is
// resolved with `getEscrow` and the amounts of the still-`Funded` escrows
// are summed per token, while the balance is read from the token contract
// (`balance(contractId)`). Settled escrows have their records reclaimed, so
// `getEscrow` answers `NotFound` for them and they contribute nothing.
//
// Event retention is the known limitation of the fallback: public RPC
// servers only retain recent history, so a rebuild that starts before the
// retained window cannot see the escrows created there and would understate
// what the contract owes. Rather than return a wrong number, the rebuild
// throws `SolvencyHistoryIncompleteError` when the history runs out; pass a
// recent `fromLedger` the RPC still retains, or use a deployment with the
// on-chain view. Read-only throughout; no secret is ever needed.
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  StrKey,
  TransactionBuilder,
  scValToNative,
} from "@stellar/stellar-sdk";
import { Api, Server as RpcServer } from "@stellar/stellar-sdk/rpc";
import { NULL_ACCOUNT } from "@stellar/stellar-sdk/contract";
import type { EscrowClient } from "./index.js";
import type { NetworkPreset } from "./networks.js";
import type { Escrow } from "./escrow-types.js";
import {
  EventCursorExpiredError,
  type GetEventsResult,
} from "./events.js";
import { NotFoundError } from "./errors.js";
import {
  MISSING_FUNCTION_ERROR,
  TESTNET_NETWORK_PASSPHRASE,
  TESTNET_RPC_URL,
} from "./internal.js";
import type { SolvencyReport } from "./pooled.js";

/** How many events one `getEvents` page holds (see `EscrowClient.getEvents`). */
const EVENTS_PAGE_SIZE = 100;

/** The event history ran out before the rebuild was complete. */
export class SolvencyHistoryIncompleteError extends Error {
  readonly name = "SolvencyHistoryIncompleteError";
  constructor(fromLedger: number) {
    super(
      `Cannot rebuild liabilities from events: the RPC server no longer retains history back to ledger ${fromLedger}. ` +
        `The result would understate what the contract owes, so no report is returned. ` +
        `Use a deployment with the on-chain solvency view, or pass a recent fromLedger that the RPC still retains.`,
    );
  }
}

/** Where the events fallback reads a token balance from. */
export interface SolvencyBalanceSource {
  /** The SEP-41 `balance` of `holder` in `token`, in raw token units. */
  getTokenBalance(token: string, holder: string): Promise<bigint>;
}

/**
 * A `SolvencyBalanceSource` that reads `balance(holder)` from a SEP-41
 * contract by simulating the view call against Soroban RPC. Simulation
 * needs no funded source account, so no keypair is involved.
 */
export function rpcTokenBalanceSource(
  options: { rpcUrl?: string; networkPassphrase?: string } = {},
): SolvencyBalanceSource {
  const rpcUrl = options.rpcUrl ?? TESTNET_RPC_URL;
  const networkPassphrase = options.networkPassphrase ?? TESTNET_NETWORK_PASSPHRASE;
  const server = new RpcServer(rpcUrl);
  return {
    async getTokenBalance(token: string, holder: string): Promise<bigint> {
      const operation = new Contract(token).call("balance", new Address(holder).toScVal());
      const transaction = new TransactionBuilder(new Account(NULL_ACCOUNT, "0"), {
        fee: BASE_FEE,
        networkPassphrase,
      })
        .addOperation(operation)
        .setTimeout(30)
        .build();
      const simulation = await server.simulateTransaction(transaction);
      if (Api.isSimulationError(simulation)) {
        throw new Error(`Simulating balance() on ${token} failed: ${simulation.error}`);
      }
      const value = scValToNative(simulation.result!.retval);
      if (typeof value !== "bigint") {
        throw new Error(`balance() on ${token} did not return an integer.`);
      }
      return value;
    },
  };
}

/** Parameters for {@link checkSolvency}. */
export interface CheckSolvencyParams {
  /** The deployed docforum-escrow contract's address (`C…`). */
  contractId: string;
  /** Token contract addresses (`C…`) to check, one report each. */
  tokens: string[];
  /** Default: Soroban testnet RPC. */
  rpcUrl?: string;
  /** Default: Stellar testnet passphrase. */
  networkPassphrase?: string;
  /** Named network preset; explicit `rpcUrl`/`networkPassphrase` still win. */
  network?: NetworkPreset;
  /** Explicit opt-in required for the Stellar mainnet passphrase. */
  allowMainnet?: boolean;
  /**
   * First ledger for the events fallback (inclusive). Defaults to 1, the
   * full history. Public RPCs retain only recent history; if the window
   * runs out, the check throws `SolvencyHistoryIncompleteError` instead
   * of understating liabilities.
   */
  fromLedger?: number;
  /**
   * Test/embedding hook: overrides the SEP-41 balance reader used by the
   * events fallback. Defaults to `rpcTokenBalanceSource`.
   */
  balanceSource?: SolvencyBalanceSource;
}

/** One token's solvency reading, as returned by {@link checkSolvency}. */
export interface TokenSolvency extends SolvencyReport {
  /** The token this reading is for. */
  token: string;
  /**
   * `"on-chain"`: the contract's `solvency` view. `"events"`: liabilities
   * rebuilt from event history (deployment predates the view).
   */
  source: "on-chain" | "events";
}

/** Result of {@link checkSolvency}. */
export interface CheckSolvencyResult {
  contractId: string;
  tokens: TokenSolvency[];
  /** Every checked token is solvent. */
  solvent: boolean;
  /** One entry per insolvent token: how much it is short, in raw units. */
  shortfalls: { token: string; shortfall: bigint }[];
}

function isMissingFunctionError(error: unknown): boolean {
  return error instanceof Error && MISSING_FUNCTION_ERROR.test(error.message);
}

function validateParams(params: CheckSolvencyParams): void {
  if (typeof params.contractId !== "string" || !StrKey.isValidContract(params.contractId)) {
    throw new TypeError(
      `contractId must be a valid contract address (C...), got ${JSON.stringify(params.contractId)}.`,
    );
  }
  if (!Array.isArray(params.tokens) || params.tokens.length === 0) {
    throw new TypeError("tokens must be a non-empty array of contract addresses.");
  }
  for (const token of params.tokens) {
    if (typeof token !== "string" || !StrKey.isValidContract(token)) {
      throw new TypeError(`token must be a valid contract address (C...), got ${JSON.stringify(token)}.`);
    }
  }
  if (
    params.fromLedger !== undefined &&
    (!Number.isSafeInteger(params.fromLedger) || params.fromLedger < 1)
  ) {
    throw new RangeError("fromLedger must be a positive safe integer.");
  }
}

async function createClient(params: CheckSolvencyParams): Promise<EscrowClient> {
  // Dynamic import: index.ts re-exports this module, so a static import
  // of the client class would be a cycle.
  const { EscrowClient } = await import("./index.js");
  return new EscrowClient({
    contractId: params.contractId,
    rpcUrl: params.rpcUrl,
    networkPassphrase: params.networkPassphrase,
    network: params.network,
    allowMainnet: params.allowMainnet,
  });
}

/**
 * Compare the contract's balance with its outstanding escrows, per token.
 *
 * Each token is read through the on-chain `solvency` view when the
 * deployment has it. If the view is missing the whole result is rebuilt
 * from events instead, so a report never mixes the two sources.
 */
export async function checkSolvency(params: CheckSolvencyParams): Promise<CheckSolvencyResult> {
  validateParams(params);
  const client = await createClient(params);
  const onChain: TokenSolvency[] = [];
  let viewMissing = false;
  for (const token of params.tokens) {
    try {
      const report = await client.getSolvency(token);
      onChain.push({ token, ...report, source: "on-chain" });
    } catch (error) {
      if (isMissingFunctionError(error)) {
        viewMissing = true;
        break;
      }
      throw error;
    }
  }
  const tokens = viewMissing ? await checkSolvencyFromEvents(client, params) : onChain;
  const shortfalls = tokens
    .filter((entry) => !entry.solvent)
    .map((entry) => ({ token: entry.token, shortfall: entry.liabilities - entry.balance }));
  return { contractId: params.contractId, tokens, solvent: shortfalls.length === 0, shortfalls };
}

async function checkSolvencyFromEvents(
  client: EscrowClient,
  params: CheckSolvencyParams,
): Promise<TokenSolvency[]> {
  const liabilities = await rebuildLiabilitiesFromEvents(client, params.fromLedger ?? 1);
  const balanceSource =
    params.balanceSource ??
    rpcTokenBalanceSource({ rpcUrl: params.rpcUrl, networkPassphrase: params.networkPassphrase });
  const reports: TokenSolvency[] = [];
  for (const token of params.tokens) {
    const owed = liabilities.get(token) ?? 0n;
    const balance = await balanceSource.getTokenBalance(token, params.contractId);
    reports.push({ token, balance, liabilities: owed, solvent: balance >= owed, source: "events" });
  }
  return reports;
}

/**
 * Sum the amounts of every still-`Funded` escrow, per token, by walking
 * the `created` events from `fromLedger` and resolving each id with
 * `getEscrow`. Settled escrows have their records reclaimed, so `getEscrow`
 * answers `NotFound` for them and they contribute nothing.
 */
async function rebuildLiabilitiesFromEvents(
  client: EscrowClient,
  fromLedger: number,
): Promise<Map<string, bigint>> {
  const liabilities = new Map<string, bigint>();
  let cursor: string | undefined;
  for (;;) {
    let page: GetEventsResult;
    try {
      page =
        cursor === undefined
          ? await client.getEvents({ fromLedger, types: ["created"] })
          : await client.getEvents({ cursor, types: ["created"] });
    } catch (error) {
      if (error instanceof EventCursorExpiredError) {
        throw new SolvencyHistoryIncompleteError(fromLedger);
      }
      throw error;
    }
    for (const event of page.events) {
      if (event.type !== "created" || event.escrowId === undefined) continue;
      let escrow: Escrow;
      try {
        escrow = await client.getEscrow(event.escrowId);
      } catch (error) {
        if (error instanceof NotFoundError) continue;
        throw error;
      }
      if (escrow.status !== "Funded") continue;
      liabilities.set(escrow.token, (liabilities.get(escrow.token) ?? 0n) + escrow.amount);
    }
    if (page.events.length < EVENTS_PAGE_SIZE) break;
    cursor = page.nextCursor;
  }
  return liabilities;
}
