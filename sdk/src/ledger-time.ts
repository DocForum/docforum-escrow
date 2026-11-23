// Ledger-clock helper (issue #335). Every deadline in the contract
// (`refund_after`, `release_not_before`, `funding_deadline`) is compared
// against the ledger close time, not the caller's clock. This module reads
// that clock through RPC and caches it briefly, so a countdown can use the
// same time base as the contract.

/**
 * How many milliseconds a ledger-time read is reused by default. Ledgers close
 * every ~5 seconds, so this is one ledger's worth: never enough to hide a
 * deadline that has already passed by more than one close time.
 */
export const DEFAULT_LEDGER_TIME_CACHE_MS = 5_000;

/** The `getLatestLedger` answer the clock needs. */
export interface LatestLedger {
  /** Sequence number of the latest ledger. */
  sequence: number;
  /**
   * Close time in unix seconds. `getLatestLedger` reports it as a string on
   * current RPC versions, so both forms are accepted; `undefined` when the RPC
   * does not report it.
   */
  closeTime?: number | string;
}

/** One reading of the chain's clock. */
export interface LedgerTime {
  /** Close time of the latest ledger, unix seconds — the contract's clock. */
  closeTime: bigint;
  /** Sequence number of the ledger the close time came from. */
  sequence: number;
  /**
   * `closeTime × 1000 - local time`, in milliseconds, measured at the same
   * moment as the read. Feed it to `useEscrowTimeline({ ledgerTimeOffsetMs })`.
   * Advisory: ledger close time lags real time, and the contract decides.
   */
  offsetMs: number;
}

/** Options for {@link LedgerClock.get}. */
export interface LedgerTimeOptions {
  /**
   * Reuse a cached read at most this many milliseconds old. Default
   * {@link DEFAULT_LEDGER_TIME_CACHE_MS}; `0` always reads fresh.
   */
  maxAgeMs?: number;
}

/**
 * A short-lived cache over the RPC's latest ledger. Concurrent callers share
 * one in-flight request, so a burst of countdowns costs one round trip.
 */
export class LedgerClock {
  private cached?: { value: LedgerTime; atMs: number };
  private inFlight?: Promise<LedgerTime>;

  /**
   * @param readLatestLedger RPC call returning the latest ledger.
   * @param now Local clock in milliseconds; defaults to `Date.now`.
   */
  constructor(
    private readonly readLatestLedger: () => Promise<LatestLedger>,
    private readonly now: () => number = Date.now,
  ) {}

  /** The ledger clock, from cache when it is younger than `maxAgeMs`. */
  async get(options: LedgerTimeOptions = {}): Promise<LedgerTime> {
    const maxAgeMs = options.maxAgeMs ?? DEFAULT_LEDGER_TIME_CACHE_MS;
    if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
      throw new RangeError(`maxAgeMs must be a non-negative number of milliseconds, got ${maxAgeMs}`);
    }
    const nowMs = this.now();
    if (maxAgeMs > 0 && this.cached && nowMs - this.cached.atMs < maxAgeMs) {
      return this.cached.value;
    }
    if (!this.inFlight) {
      this.inFlight = this.read().finally(() => {
        this.inFlight = undefined;
      });
    }
    return this.inFlight;
  }

  /** {@link LedgerClock.get}, reduced to the offset used by countdowns. */
  async offsetMs(options: LedgerTimeOptions = {}): Promise<number> {
    return (await this.get(options)).offsetMs;
  }

  /** Drops the cache, so the next read goes to the network. */
  clear(): void {
    this.cached = undefined;
  }

  private async read(): Promise<LedgerTime> {
    const latest = await this.readLatestLedger();
    const closeSeconds = latest.closeTime === undefined ? Number.NaN : Number(latest.closeTime);
    if (!Number.isFinite(closeSeconds)) {
      throw new Error("The RPC did not report a ledger close time; cannot derive the contract clock.");
    }
    // Both clocks are sampled together, so the offset stays valid however
    // long the cached value is reused.
    const localMs = this.now();
    const value: LedgerTime = {
      closeTime: BigInt(closeSeconds),
      sequence: latest.sequence,
      offsetMs: closeSeconds * 1000 - localMs,
    };
    this.cached = { value, atMs: localMs };
    return value;
  }
}
