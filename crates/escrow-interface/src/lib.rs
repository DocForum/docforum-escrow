#![no_std]

use soroban_sdk::{
    contractclient, contracterror, contracttype, Address, Env, String, Vec,
};

/// The status values returned by the escrow contract.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EscrowStatus {
    Funded,
    Released,
    Refunded,
    Cancelled,
}

/// A direct release recipient and its share in basis points.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PayeeShare {
    pub payee: Address,
    pub basis_points: u32,
}

/// The funded escrow record returned by `get_escrow`.
#[contracttype]
#[derive(Clone)]
pub struct EscrowData {
    pub payer: Address,
    pub payee: Address,
    pub token: Address,
    pub amount: i128,
    pub condition_ref: String,
    pub status: EscrowStatus,
    pub releasers: Vec<Address>,
    pub threshold: u32,
    pub refund_after: Option<u64>,
    pub payees: Vec<PayeeShare>,
    pub notify_payee: bool,
    pub requires_acceptance: bool,
    pub accepted_at: Option<u64>,
    pub refund_to: Address,
    pub release_not_before: Option<u64>,
    pub fee_recipient: Option<Address>,
    pub fee_bps: Option<u32>,
}

/// Errors returned by the escrow contract.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotFound = 1,
    InvalidAmount = 2,
    Unauthorized = 3,
    NotFunded = 4,
    InvalidRefundAfter = 5,
    BalanceMismatch = 6,
    ConditionRefTooLong = 7,
    DisallowedToken = 8,
    CallbackFailed = 9,
    InvalidNewPayee = 37,
    Overflow = 12,
    InvalidThreshold = 13,
    TooManyReleasers = 14,
    ThresholdNotMet = 15,
    DuplicateApprover = 16,
    DuplicateReleaser = 17,
    AcceptanceRequired = 18,
    AcceptanceNotConfigured = 19,
    AlreadyAccepted = 20,
    InvalidReleaser = 24,
    InvalidRefundTo = 21,
    InvalidReleaseNotBefore = 22,
    ReleaseTooEarly = 23,
    BatchTooLarge = 25,
    NotPooled = 26,
    FundingDeadlinePassed = 27,
    FundingTargetReached = 28,
    FundingIncomplete = 29,
    RefundNotOpen = 30,
    AlreadyRefunded = 31,
    NoContribution = 32,
    NotSupportedForPooled = 33,
    InvalidFundingDeadline = 34,
    InvalidSettlementAmount = 52,
    SettlementNotSupported = 53,
    InvalidFee = 35,
    InvalidPayeeList = 41,
    TooManyPayees = 42,
    DuplicatePayee = 43,
    InvalidBasisPoints = 44,
    SplitAmountOverflow = 45,
    PoolInsufficient = 47,
    NotStreamed = 48,
    InvalidVestingSchedule = 49,
    NothingToWithdraw = 50,
    StreamTopUpUnsupported = 51,
    InvalidRefundExtension = 46,
    Undeliverable = 36,
    Paused = 38,
    AlreadyPaused = 39,
    NotPaused = 40,
}

/// The stable cross-contract surface for the escrow's core lifecycle.
#[contractclient(name = "EscrowClient")]
pub trait Escrow {
    fn create_escrow(
        env: Env,
        payer: Address,
        payee: Address,
        token: Address,
        amount: i128,
        condition_ref: String,
        releaser: Address,
        refund_after: Option<u64>,
        notify_payee: bool,
        refund_to: Option<Address>,
        fee_recipient: Option<Address>,
        fee_bps: Option<u32>,
    ) -> Result<u64, Error>;

    fn get_status(env: Env, escrow_id: u64) -> Result<EscrowStatus, Error>;

    fn get_escrow(env: Env, escrow_id: u64) -> Result<EscrowData, Error>;

    fn release(env: Env, escrow_id: u64, caller: Address) -> Result<(), Error>;

    fn refund(env: Env, escrow_id: u64, caller: Address) -> Result<(), Error>;
}
