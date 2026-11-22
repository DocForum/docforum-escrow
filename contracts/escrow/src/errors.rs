//! Contract `Error` codes. Append-only: never renumber or remove a variant (contract-changes.d/README.md).

use crate::*;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotFound = 1,
    InvalidAmount = 2,
    Unauthorized = 3,
    NotFunded = 4,
    /// `refund_after` was not strictly in the future at creation — see
    /// docs/adr/0004: a deadline that has already passed would let
    /// anyone refund the escrow before the releaser could ever act.
    InvalidRefundAfter = 5,
    /// The contract's token balance didn't rise by exactly `amount`
    /// across `create_escrow`'s transfer (a lying or short-delivering
    /// token) — see docs/threat-model.md T5.
    BalanceMismatch = 6,
    /// `condition_ref` exceeded the maximum allowed length (currently
    /// 64 bytes) — see docs/threat-model.md T10 and ROADMAP.md Phase E5.
    /// Bounded to keep storage and event costs predictable; reject at
    /// creation so no on-chain storage is wasted on an oversized ref.
    ConditionRefTooLong = 7,
    /// `token` is not in the immutable deploy-time allowlist.
    DisallowedToken = 8,
    /// The opted-in payee callback returned an error or could not be
    /// invoked. The release transaction (including its transfer) rolls back.
    CallbackFailed = 9,
    /// `new_payee` is invalid: it is either the contract's own address
    /// or the payer's address. The contract address can never sign to
    /// accept a payout; the payer is excluded so a payer cannot redirect
    /// the release destination to themselves via a colluding payee.
    InvalidNewPayee = 37,
    Overflow = 12,
    /// The releaser set is empty, or `threshold` is 0 or larger than the
    /// number of releasers — see docs/adr/0007.
    InvalidThreshold = 13,
    /// More than `MAX_RELEASERS` (10) addresses were supplied at creation.
    TooManyReleasers = 14,
    /// Fewer distinct approvals were supplied than the escrow's threshold,
    /// or a single releaser tried to settle a quorum escrow through the
    /// single-caller entry point.
    ThresholdNotMet = 15,
    /// The same address appeared twice in one approval list. Duplicates
    /// never count twice toward the threshold.
    DuplicateApprover = 16,
    /// The same address appeared twice in the releaser set at creation.
    DuplicateReleaser = 17,
    AcceptanceRequired = 18,
    AcceptanceNotConfigured = 19,
    AlreadyAccepted = 20,
    /// The new releaser cannot be the escrow contract or payee.
    InvalidReleaser = 24,
    /// `refund_to` was the escrow contract's own address — funds sent
    /// there on refund could never be moved again (docs/adr/0009).
    InvalidRefundTo = 21,
    /// The configured release time is in the past or after the refund time.
    InvalidReleaseNotBefore = 22,
    /// Release was attempted before the configured time.
    ReleaseTooEarly = 23,
    /// A batch call was passed more than `MAX_BATCH_SIZE` items — see
    /// docs/adr/0012. Callers must chunk. Appended at the end so existing
    /// discriminants keep their on-chain values.
    BatchTooLarge = 25,
    /// `contribute`/`claim_refund`/`get_contribution` on a non-pooled
    /// escrow, or `get_pooled` on a non-pooled/unknown id — see
    /// docs/adr/0011.
    NotPooled = 26,
    /// A contribution arrived after the pooled escrow's funding deadline.
    /// Late contributions can never be accepted: the round's outcome
    /// (release vs per-contributor refunds) is fixed at the deadline.
    FundingDeadlinePassed = 27,
    /// A contribution would push the pooled total past the funding target
    /// (overfunding is rejected, not accepted), the target is already met,
    /// or a refund was claimed on a fully funded pooled escrow.
    FundingTargetReached = 28,
    /// `release` on a pooled escrow whose funded total is below the
    /// funding target — partial funding is never releasable.
    FundingIncomplete = 29,
    /// `claim_refund` before the funding deadline passed on a round that
    /// is still (or now fully) funded. Claims open only for a failed round.
    RefundNotOpen = 30,
    /// The same contributor tried to claim a refund twice.
    AlreadyRefunded = 31,
    /// `claim_refund` by an address with no recorded contribution.
    NoContribution = 32,
    /// `refund`/`refund_with_approvals`/`cancel`/`top_up` on a pooled
    /// escrow: pushing the whole pooled total to one address would violate
    /// per-contributor accounting. Pooled refunds are pull-based
    /// (`claim_refund`); pooled funding is `contribute`-only.
    NotSupportedForPooled = 33,
    /// The funding deadline was not strictly in the future at creation.
    InvalidFundingDeadline = 34,
    /// A split settlement amount is outside the escrowed range.
    InvalidSettlementAmount = 52,
    /// `settle` on a streamed (vesting) or multi-payee split escrow: those
    /// have their own settlement rules, so use `release`/`refund`.
    SettlementNotSupported = 53,
    /// The optional protocol fee was misconfigured at creation: `bps`
    /// above [`MAX_FEE_BPS`] (10 %), a recipient equal to the escrow
    /// contract itself, or an amount that would overflow the fee math —
    /// see docs/adr/0010.
    InvalidFee = 35,
    InvalidPayeeList = 41,
    TooManyPayees = 42,
    DuplicatePayee = 43,
    InvalidBasisPoints = 44,
    SplitAmountOverflow = 45,
    /// The contract's token balance is below the requested stream payout.
    PoolInsufficient = 47,
    /// `withdraw`/`get_vesting` on an escrow without a schedule.
    NotStreamed = 48,
    /// Invalid start/end order or cliff outside the schedule bounds.
    InvalidVestingSchedule = 49,
    /// No vested amount is left to withdraw.
    NothingToWithdraw = 50,
    /// Streams have a fixed total; `top_up` is rejected.
    StreamTopUpUnsupported = 51,
    /// The refund deadline is absent, already elapsed, or the replacement
    /// deadline is not strictly later than the current one (issue #41).
    InvalidRefundExtension = 46,
    /// An outbound release transfer failed; the funded escrow remains
    /// retryable and may still use its refund path.
    Undeliverable = 36,
    /// A deposit path was called while the emergency pause is on — see
    /// docs/adr/0011.
    Paused = 38,
    /// `pause` on an already-paused contract. The transition did not
    /// happen, so no event is emitted.
    AlreadyPaused = 39,
    /// `unpause` on a running contract. The transition did not happen, so
    /// no event is emitted.
    NotPaused = 40,
    /// A deposit would make one escrow exceed its immutable per-token cap.
    AmountCapExceeded = 5600,
    /// The constructor cap table contains a non-positive amount or duplicate
    /// token.
    InvalidAmountCap = 5601,
    /// `release_with_attestation` was called on an escrow with no
    /// `attester` configured (Phase E5, issue #42).
    AttesterNotConfigured = 54,
    /// `fund_next` before the next period is due (issue #115).
    ScheduleTooEarly = 55,
    /// `fund_next` after every period was funded (issue #115).
    ScheduleComplete = 56,
    /// `fund_next` or a second `cancel_schedule` on a cancelled schedule
    /// (issue #115).
    ScheduleCancelled = 57,
    /// The payer's allowance for this contract is below one period's
    /// amount — or has expired, which reads as zero (issue #115).
    AllowanceExhausted = 58,
    /// A schedule with a zero period or zero total periods (issue #115).
    InvalidSchedule = 59,
}
