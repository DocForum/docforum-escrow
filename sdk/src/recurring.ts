// Recurring escrows funded through SEP-41 allowances (issue #115, ADR 0015;
// SDK surface issue #468). Types and pure helpers only; the EscrowClient
// methods that call the contract live in index.ts.
import { type EscrowSigner } from "./signers/types.js";

/** Parameters for {@link EscrowClient.createSchedule}. */
export interface CreateScheduleParams {
  /**
   * Signs `create_schedule` and funds every period. Funding pulls from this
   * account with `transfer_from` under the allowance it grants the escrow
   * contract (see {@link EscrowClient.approveScheduleAllowance}).
   */
  payer: EscrowSigner;
  /** Payee of every period escrow. Must not be the escrow contract itself. */
  payee: string;
  /** SEP-41 token pulled each period. Must be on the deployment's allowlist, if it has one. */
  token: string;
  /** Raw token units pulled per period. Must be positive. */
  amount: bigint;
  /**
   * Stored verbatim on every period escrow: opaque and public on-chain
   * forever. At most `MAX_CONDITION_REF_LENGTH` (64) UTF-8 bytes.
   */
  conditionRef: string;
  /** Single releaser of every period escrow. Must not be the escrow contract itself. */
  releaser: string;
  /**
   * Relative refund window, in seconds. Each period escrow's `refundAfter`
   * is **the ledger time at which that period is funded plus this window**,
   * not an absolute deadline: a period funded late gets a later deadline.
   * Omit for no refund deadline. Must be positive when given: a window of 0
   * would make every `fund_next` fail with `InvalidRefundAfter`.
   */
  refundAfterSeconds?: bigint;
  /** Seconds between period due times. Must be positive. */
  periodSeconds: bigint;
  /** Number of periods the schedule funds in total. A positive `u32`. */
  totalPeriods: number;
  /**
   * Ledger timestamp (unix seconds) the first period becomes due. A time
   * already passed means the first `fundNext` may run immediately.
   */
  firstDue: bigint;
}

/** A recurring schedule as stored on-chain, returned by {@link EscrowClient.getSchedule}. */
export interface RecurringSchedule {
  payer: string;
  payee: string;
  token: string;
  /** Raw token units pulled for each period. */
  amount: bigint;
  conditionRef: string;
  releaser: string;
  /**
   * Relative refund window in seconds, applied to each period escrow when it
   * is funded (`refundAfter = funding ledger time + refundAfterSeconds`).
   * `undefined` means period escrows have no refund deadline.
   */
  refundAfterSeconds?: bigint;
  /** Seconds between period due times. */
  periodSeconds: bigint;
  /** Periods the schedule funds in total. */
  totalPeriods: number;
  /** Periods already funded. */
  periodsFunded: number;
  /**
   * Ledger timestamp the next period becomes due. Advances by exactly
   * `periodSeconds` per `fund_next`, so a late keeper leaves the following
   * period due immediately.
   */
  nextDue: bigint;
  /** Set by `cancel_schedule`; a cancelled schedule never funds again. */
  cancelled: boolean;
}

/** Options for {@link EscrowClient.fundNext}. */
export interface FundNextOptions {
  /**
   * Pays the transaction fee. Anyone may fund a due period (a keeper); the
   * payer's allowance is the authorization, so no payer signature is needed.
   */
  source: EscrowSigner;
}

/** Parameters for {@link EscrowClient.cancelSchedule}. */
export interface CancelScheduleParams {
  scheduleId: bigint;
  /** The schedule's payer; must sign. Period escrows already funded are unaffected. */
  payer: EscrowSigner;
}

/**
 * Parameters for {@link EscrowClient.approveScheduleAllowance}: the payer's
 * SEP-41 `approve(from = payer, spender = escrow contract, amount,
 * expiration_ledger)` call.
 */
export interface ApproveScheduleAllowanceParams {
  /** Owner of the funds; signs the approval. */
  payer: EscrowSigner;
  /** The SEP-41 token contract. */
  token: string;
  /**
   * The new allowance, in raw units. It **replaces** the current allowance
   * rather than adding to it, and is shared by every schedule this payer has
   * on this escrow contract in this token, so size it for all of them (sum
   * {@link scheduleAllowanceNeeded} over those schedules). `0n` revokes it.
   */
  amount: bigint;
  /**
   * Ledger sequence after which the allowance lapses. It must cover the last
   * period you expect to fund; see {@link scheduleAllowanceExpirationLedger}.
   * Tokens cap how far ahead this may be (the persistent-entry TTL limit).
   */
  expirationLedger: number;
}

/**
 * Where a schedule stands relative to the ledger clock, from
 * {@link scheduleState}:
 * - `due`: `fund_next` would fund a period now;
 * - `waiting`: the next period isn't due yet (`fund_next` → `ScheduleTooEarly`);
 * - `complete`: every period is funded (`fund_next` → `ScheduleComplete`);
 * - `cancelled`: the payer cancelled (`fund_next` → `ScheduleCancelled`).
 */
export type ScheduleState = "due" | "waiting" | "complete" | "cancelled";

/**
 * Pure: classifies `schedule` at `ledgerTime` (unix seconds of the latest
 * ledger, e.g. `(await client.getLedgerTime()).closeTime`). Pass ledger time,
 * not `Date.now()`: the contract compares against the ledger clock.
 *
 * Checks run in `fund_next`'s order (`recurring.rs`): cancelled, then
 * complete (`periodsFunded >= totalPeriods`), then `ledgerTime < nextDue`
 * means waiting; otherwise due. A late keeper funds one period per call and
 * `nextDue` advances by one `periodSeconds`, so the schedule can be `due`
 * again straight after a fund. Advisory only: the contract decides, and
 * `due` says nothing about the payer's allowance or balance.
 */
export function scheduleState(
  schedule: Pick<RecurringSchedule, "cancelled" | "periodsFunded" | "totalPeriods" | "nextDue">,
  ledgerTime: bigint,
): ScheduleState {
  if (schedule.cancelled) return "cancelled";
  if (schedule.periodsFunded >= schedule.totalPeriods) return "complete";
  if (ledgerTime < schedule.nextDue) return "waiting";
  return "due";
}

/** Pure: periods not yet funded. `0` for a cancelled or complete schedule. */
export function remainingPeriods(
  schedule: Pick<RecurringSchedule, "cancelled" | "periodsFunded" | "totalPeriods">,
): number {
  if (schedule.cancelled) return 0;
  return Math.max(0, schedule.totalPeriods - schedule.periodsFunded);
}

/**
 * Pure: the allowance the payer still needs to grant the escrow contract for
 * this schedule to complete — remaining periods × `amount`. `0n` once the
 * schedule is cancelled or complete.
 *
 * SEP-41 allowances are per `(payer, spender)` per token, and the spender is
 * the escrow contract, not the schedule: **every schedule the same payer has
 * on this contract in this token draws on the same allowance**. Sum this
 * over all of them before calling `approve`, which replaces (does not add
 * to) the current allowance. Grant it with
 * {@link EscrowClient.approveScheduleAllowance}, or call the token's
 * `approve(payer, escrowContractId, amount, expirationLedger)` yourself.
 */
export function scheduleAllowanceNeeded(
  schedule: Pick<RecurringSchedule, "cancelled" | "periodsFunded" | "totalPeriods" | "amount">,
): bigint {
  return BigInt(remainingPeriods(schedule)) * schedule.amount;
}

/** Average ledger close time used by {@link scheduleAllowanceExpirationLedger}. */
export const DEFAULT_SECONDS_PER_LEDGER = 5;

/**
 * Pure estimate: a ledger sequence late enough for an allowance to still be
 * live when the schedule's last period falls due. Converts the time from
 * `latest.closeTime` to the last due time at `secondsPerLedger` (default
 * 5 s), then adds `marginLedgers` (default ≈ one day) for keeper lateness and
 * close-time drift. Ledger close times vary, so treat it as a floor and
 * prefer re-approving over a long schedule. Tokens cap the expiration at
 * the persistent-entry TTL limit; a schedule longer than that needs the
 * allowance renewed while it runs.
 */
export function scheduleAllowanceExpirationLedger(
  schedule: Pick<RecurringSchedule, "cancelled" | "periodsFunded" | "totalPeriods" | "nextDue" | "periodSeconds">,
  latest: { sequence: number; closeTime: bigint },
  options: { secondsPerLedger?: number; marginLedgers?: number } = {},
): number {
  const secondsPerLedger = options.secondsPerLedger ?? DEFAULT_SECONDS_PER_LEDGER;
  const marginLedgers = options.marginLedgers ?? Math.ceil(86_400 / secondsPerLedger);
  if (!Number.isFinite(secondsPerLedger) || secondsPerLedger <= 0) {
    throw new RangeError("secondsPerLedger must be a positive number.");
  }
  if (!Number.isInteger(marginLedgers) || marginLedgers < 0) {
    throw new RangeError("marginLedgers must be a non-negative whole number of ledgers.");
  }
  const remaining = remainingPeriods(schedule);
  if (remaining === 0) return latest.sequence;
  const lastDue = schedule.nextDue + BigInt(remaining - 1) * schedule.periodSeconds;
  const secondsAhead = lastDue > latest.closeTime ? lastDue - latest.closeTime : 0n;
  const ledgersAhead = Math.ceil(Number(secondsAhead) / secondsPerLedger);
  return latest.sequence + ledgersAhead + marginLedgers;
}

/**
 * A `createSchedule` argument the contract would reject, caught before any
 * transaction is built. `contractError` names the error the contract (or the
 * first `fund_next`, for rules only checked at funding time) would return.
 */
export class ScheduleParamsError extends Error {
  /** The contract error this rule mirrors, e.g. `InvalidSchedule`. */
  readonly contractError: string;
  constructor(contractError: string, message: string) {
    super(`${contractError}: ${message}`);
    this.name = "ScheduleParamsError";
    this.contractError = contractError;
  }
}
