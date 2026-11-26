#![no_std]

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, token, Address, Env};

/// Errors returned by the example payee contract.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// The escrow id passed to `on_escrow_released` was not registered.
    UnknownEscrow = 1,
    /// The payee has armed reject mode to simulate a failing hook.
    Rejected = 2,
    /// `amount` is not positive, or this contract's token balance has not
    /// grown by `amount` since the last recorded payout: the call is not
    /// backed by a real transfer, so nothing is recorded.
    UnbackedPayout = 3,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    /// The address allowed to `register_escrow` and `set_reject`.
    Admin,
    /// The token this payee is paid in; its balance backs every payout.
    Token,
    /// This contract's token balance as of the last recorded payout.
    LastBalance,
    /// `Known(escrow_id)` marks an escrow the payee expects a payout from.
    Known(u64),
    LastId,
    LastAmount,
    TotalReceived,
    RejectMode,
}

/// Example contract payee implementing the `on_escrow_released(escrow_id,
/// amount)` release callback defined in ADR 0005.
///
/// An escrow created with `notify_payee: true` invokes this hook after the
/// token transfer, passing the escrow id and the amount paid (net of any
/// protocol fee). The hook records the payout and rejects escrows it does not
/// recognise, so an integrator can copy this pattern and add their own
/// business logic.
///
/// The hook itself is callable by anyone, so it never trusts its `amount`
/// argument on its own: a payout is recorded only when this contract's
/// balance of the configured token has really grown by `amount` since the
/// last recorded payout. Configuration (`register_escrow`, `set_reject`) is
/// restricted to the admin set at deployment.
#[contract]
pub struct PayeeCallback;

#[contractimpl]
impl PayeeCallback {
    /// Deploy-time setup: `admin` controls configuration, `token` is the
    /// token escrows pay this contract in.
    pub fn __constructor(env: Env, admin: Address, token: Address) {
        let storage = env.storage().instance();
        storage.set(&DataKey::Admin, &admin);
        storage.set(&DataKey::Token, &token);
        let balance = token::Client::new(&env, &token).balance(&env.current_contract_address());
        storage.set(&DataKey::LastBalance, &balance);
    }

    /// Register `escrow_id` as an escrow this payee expects to receive from.
    /// Admin only.
    pub fn register_escrow(env: Env, escrow_id: u64) {
        Self::admin(&env).require_auth();
        env.storage().persistent().set(&DataKey::Known(escrow_id), &true);
    }

    /// Arm/disarm reject mode. When armed, `on_escrow_released` fails with
    /// `Rejected`, which reverts the release atomically. Admin only.
    pub fn set_reject(env: Env, reject: bool) {
        Self::admin(&env).require_auth();
        env.storage().instance().set(&DataKey::RejectMode, &reject);
    }

    /// The last payout recorded by the hook: `(escrow_id, amount)`.
    pub fn last_payout(env: Env) -> (u64, i128) {
        let storage = env.storage().instance();
        (
            storage.get(&DataKey::LastId).unwrap_or(0),
            storage.get(&DataKey::LastAmount).unwrap_or(0),
        )
    }

    /// Total amount received across all payouts recorded by the hook.
    pub fn total_received(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::TotalReceived)
            .unwrap_or(0)
    }

    /// Whether `escrow_id` has been registered as known.
    pub fn is_known(env: Env, escrow_id: u64) -> bool {
        env.storage().persistent().has(&DataKey::Known(escrow_id))
    }

    /// The release callback invoked by the escrow contract after paying out.
    ///
    /// `amount` is the amount actually paid to this payee (net of the
    /// protocol fee, if any). A returned error reverts the whole release
    /// atomically: the escrow stays `Funded` and the payee receives nothing.
    ///
    /// Anyone can call this entry point directly, so the payout is recorded
    /// only if this contract's token balance grew by at least `amount` since
    /// the last recorded payout (`UnbackedPayout` otherwise). If you add a
    /// withdrawal entry point, update `LastBalance` there too.
    pub fn on_escrow_released(env: Env, escrow_id: u64, amount: i128) -> Result<(), Error> {
        if !env.storage().persistent().has(&DataKey::Known(escrow_id)) {
            return Err(Error::UnknownEscrow);
        }
        let storage = env.storage().instance();
        if storage
            .get::<_, bool>(&DataKey::RejectMode)
            .unwrap_or(false)
        {
            return Err(Error::Rejected);
        }
        if amount <= 0 {
            return Err(Error::UnbackedPayout);
        }
        let token: Address = storage.get(&DataKey::Token).unwrap();
        let balance = token::Client::new(&env, &token).balance(&env.current_contract_address());
        let last_balance: i128 = storage.get(&DataKey::LastBalance).unwrap_or(0);
        match balance.checked_sub(last_balance) {
            Some(grown) if grown >= amount => {}
            _ => return Err(Error::UnbackedPayout),
        }
        // Consume only `amount` of the growth, so a later payout in the same
        // ledger cannot be backed twice by the same transfer.
        storage.set(&DataKey::LastBalance, &(last_balance + amount));
        storage.set(&DataKey::LastId, &escrow_id);
        storage.set(&DataKey::LastAmount, &amount);
        let total = storage
            .get::<_, i128>(&DataKey::TotalReceived)
            .unwrap_or(0);
        storage.set(&DataKey::TotalReceived, &(total + amount));
        Ok(())
    }
}

impl PayeeCallback {
    fn admin(env: &Env) -> Address {
        env.storage().instance().get(&DataKey::Admin).unwrap()
    }
}
