import { type EscrowSigner } from "./signers/types.js";
import { type CreateEscrowParams, MAX_CONDITION_REF_LENGTH } from "./escrow-types.js";
import { utf8ByteLength } from "./escrow-types.js";

/**
 * One tranche of a milestone schedule. A milestone escrow is a *group* of
 * single-tranche escrows — see `createMilestoneEscrow`.
 */
export type MilestoneStatus = "unreleased" | "released" | "refunded";

/** A single tranche of a milestone escrow. */
export interface Milestone {
  /** Position in the schedule, `0`-based — pass this to `releaseMilestone`. */
  index: number;
  /** Tranche amount in the token's smallest unit. */
  amount: bigint;
  /** The escrow that holds this tranche — see `createMilestoneEscrow`. */
  escrowId: bigint;
  status: MilestoneStatus;
}

/** Largest value an `i128` can hold — the contract's arithmetic type. */
const I128_MAX = 2n ** 127n - 1n;

/**
 * `condition_ref` is capped on-chain at `MAX_CONDITION_REF_LENGTH` bytes
 * (`contracts/escrow/src/lib.rs` `MAX_CONDITION_REF_LEN`, threat model T10);
 * a longer value is rejected with `ConditionRefTooLong`. A milestone group
 * tags each tranche, so the base ref has that much less room.
 */

/**
 * Thrown when a milestone schedule is invalid. Caught before any network
 * call, so an obviously-invalid schedule costs nothing.
 */
export class MilestoneScheduleError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`Invalid milestone schedule: ${reason}`);
    this.name = "MilestoneScheduleError";
    this.reason = reason;
  }
}

/**
 * `amount` must be positive, the schedule non-empty, every tranche positive,
 * the sum exactly `amount`, and every value representable as an `i128`.
 * Pure and synchronous: a malformed schedule is a programmer error, not a
 * transaction to pay for.
 */
export function validateMilestoneSchedule(milestones: readonly bigint[], amount: bigint): void {
  if (amount <= 0n) throw new MilestoneScheduleError(`amount must be positive, got ${amount}`);
  if (milestones.length === 0) throw new MilestoneScheduleError("schedule must not be empty");
  let sum = 0n;
  for (const [index, tranche] of milestones.entries()) {
    if (tranche <= 0n) throw new MilestoneScheduleError(`tranche ${index} must be positive, got ${tranche}`);
    if (tranche > I128_MAX) throw new MilestoneScheduleError(`tranche ${index} exceeds the i128 maximum`);
    sum += tranche;
    if (sum > I128_MAX) throw new MilestoneScheduleError("schedule total exceeds the i128 maximum");
  }
  if (sum !== amount) {
    throw new MilestoneScheduleError(`schedule sums to ${sum} but amount is ${amount}`);
  }
}

/**
 * `condition_ref` for tranche `index` of `count`: `<base>#m<index+1>/<count>`.
 * Tagged so each tranche stays traceable back to its group on-chain, where
 * only the ref is visible. Length is checked in UTF-8 bytes, matching the
 * contract: the byte limit is `MAX_CONDITION_REF_LENGTH`, and the message
 * reports bytes rather than characters.
 */
export function milestoneConditionRef(base: string, index: number, count: number): string {
  const ref = `${base}#m${index + 1}/${count}`;
  const bytes = utf8ByteLength(ref);
  if (bytes > MAX_CONDITION_REF_LENGTH) {
    throw new MilestoneScheduleError(
      `conditionRef "${base}" is too long: the tranche tag needs "${ref}" (${bytes} bytes) but the contract allows ${MAX_CONDITION_REF_LENGTH} bytes`,
    );
  }
  return ref;
}

/**
 * Thrown when `createMilestoneEscrow` fails partway through: a group is N
 * separate transactions, so the tranches before the failure are already
 * funded on-chain and must be dealt with by the caller.
 */
export class MilestoneEscrowPartialError extends Error {
  /** Escrow ids of the tranches that were created, in schedule order. */
  readonly createdEscrowIds: readonly bigint[];
  /** How many tranches had been created when the failure happened. */
  readonly createdCount: number;
  /** Total tranches the schedule asked for. */
  readonly totalCount: number;
  override readonly cause?: unknown;

  constructor(createdEscrowIds: readonly bigint[], createdCount: number, totalCount: number, cause?: unknown) {
    super(
      `Milestone escrow creation failed at tranche ${createdCount + 1} of ${totalCount}; ` +
        `${createdCount} tranche escrow(s) already exist and are funded: [${createdEscrowIds.join(", ")}]. ` +
        "Release or refund them, then retry the remaining tranches.",
    );
    this.name = "MilestoneEscrowPartialError";
    this.createdEscrowIds = createdEscrowIds;
    this.createdCount = createdCount;
    this.totalCount = totalCount;
    this.cause = cause;
  }
}

/** Parameters for {@link EscrowClient.createMilestoneEscrow} — one escrow per tranche. */
export interface CreateMilestoneEscrowParams extends Omit<CreateEscrowParams, "amount"> {
  /** Total across all tranches; must equal the sum of `milestones`. */
  amount: bigint;
  /**
   * Tranche schedule in payout order. Every entry must be positive and the
   * entries must sum exactly to `amount`; validated before any transaction
   * (`MilestoneScheduleError`).
   */
  milestones: readonly bigint[];
}

/**
 * A milestone schedule, as returned by `createMilestoneEscrow`: one
 * single-tranche escrow per tranche, in schedule order.
 */
export interface MilestoneEscrow {
  milestones: Milestone[];
  /** The tranche escrow ids, in schedule order. */
  escrowIds: bigint[];
}

/** Release params for one tranche of a milestone escrow. */
export interface ReleaseMilestoneParams {
  /** The group returned by `createMilestoneEscrow`. */
  escrow: MilestoneEscrow;
  /** `0`-based position in the schedule. */
  milestoneIndex: number;
  /** Must be that tranche's `releaser` (set at creation) — see docs/adr/0002. */
  caller: EscrowSigner;
}

/** Refund params for one tranche of a milestone escrow — same rules as `refund`. */
export interface RefundMilestoneParams {
  escrow: MilestoneEscrow;
  milestoneIndex: number;
  caller: EscrowSigner;
}
