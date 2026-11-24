/** Public SDK types and deterministic helpers for fixed-total vesting streams. */

export interface VestingSchedule {
  /** Ledger timestamp at which linear vesting starts. */
  start: bigint;
  /** Ledger timestamp at which the full amount is vested. */
  end: bigint;
  /** Optional ledger timestamp before which no amount is available. */
  cliff?: bigint;
}

/** Minimal stream shape accepted by the deterministic vesting helpers. */
export interface StreamedEscrow {
  /** Fixed amount locked by the stream, in the token's smallest unit. */
  amount: bigint;
  schedule: VestingSchedule;
}

/** Arguments for {@link EscrowClient.createStreamedEscrow}. */
export interface CreateStreamedEscrowParams {
  /** Signs and pays for the stream creation. */
  payer: import("./signers/types.js").EscrowSigner;
  /** Address that can withdraw vested funds. */
  payee: string;
  /** SEP-41 token contract address. */
  token: string;
  /** Fixed stream amount in the token's smallest unit. */
  amount: bigint;
  /** Opaque contract reference, limited to the contract's condition bound. */
  conditionRef: string;
  /** Address authorized to settle the stream. */
  releaser: string;
  /** Optional unix timestamp after which anyone may refund. */
  refundAfter?: bigint;
  /** Linear vesting schedule. */
  schedule: VestingSchedule;
}

/** Arguments for {@link EscrowClient.withdraw}. */
export interface WithdrawParams {
  /** Stream escrow id. */
  escrowId: bigint;
  /** Stream payee; signs the withdrawal. */
  payee: import("./signers/types.js").EscrowSigner;
}

/** Current on-chain vesting state returned by {@link EscrowClient.getVesting}. */
export interface VestingInfo {
  /** Stream schedule. */
  schedule: VestingSchedule;
  /** Fixed amount originally deposited. */
  totalAmount: bigint;
  /** Amount vested at the contract's current ledger timestamp. */
  vestedAmount: bigint;
  /** Amount already withdrawn by the payee. */
  withdrawnAmount: bigint;
  /** Vested amount still available to withdraw. */
  claimableAmount: bigint;
}

/** One key schedule timestamp and the amount newly vested by that point. */
export interface VestingTimelineEntry {
  /** Which schedule milestone this entry represents. */
  kind: "start" | "cliff" | "end";
  /** Ledger timestamp of the milestone. */
  timestamp: bigint;
  /** Total amount vested at this timestamp. */
  vestedAmount: bigint;
  /** Increase from the preceding timeline entry. */
  unlocks: bigint;
}

/** Validate the same schedule constraints enforced by `create_streamed_escrow`. */
export function validateVestingSchedule(schedule: VestingSchedule): void {
  if (schedule.start < 0n || schedule.end < 0n) {
    throw new RangeError("vesting timestamps must be non-negative");
  }
  if (schedule.start >= schedule.end) {
    throw new RangeError("vesting schedule start must be before end");
  }
  if (schedule.cliff !== undefined && (schedule.cliff < schedule.start || schedule.cliff > schedule.end)) {
    throw new RangeError("vesting cliff must be between start and end");
  }
}

/** Return the amount vested at a ledger timestamp using the contract's integer math. */
export function vestedAt(escrow: StreamedEscrow, timestamp: bigint): bigint {
  validateVestingSchedule(escrow.schedule);
  if (timestamp < 0n) throw new RangeError("vesting timestamp must be non-negative");
  const { start, end, cliff } = escrow.schedule;
  if (timestamp < start || (cliff !== undefined && timestamp < cliff)) return 0n;
  if (timestamp >= end) return escrow.amount;

  const duration = end - start;
  const elapsed = timestamp - start;
  return (escrow.amount / duration) * elapsed + ((escrow.amount % duration) * elapsed) / duration;
}

/** Return the stream's start, cliff (when present), and end with incremental unlocks. */
export function timelineOf(escrow: StreamedEscrow): VestingTimelineEntry[] {
  validateVestingSchedule(escrow.schedule);
  const timestamps = [escrow.schedule.start, escrow.schedule.cliff, escrow.schedule.end]
    .filter((timestamp): timestamp is bigint => timestamp !== undefined)
    .filter((timestamp, index, all) => all.indexOf(timestamp) === index);
  let previous = 0n;
  return timestamps.map((timestamp, index) => {
    const vestedAmount = vestedAt(escrow, timestamp);
    const kind = timestamp === escrow.schedule.end
      ? "end"
      : timestamp === escrow.schedule.cliff
      ? "cliff"
      : "start";
    const entry = { kind, timestamp, vestedAmount, unlocks: vestedAmount - previous } satisfies VestingTimelineEntry;
    previous = vestedAmount;
    return entry;
  });
}
