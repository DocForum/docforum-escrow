#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, testutils::Address as _,
    Address, Env,
};

/// Errors returned by the example payee contract.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// The escrow id passed to `on_escrow_released` was not registered.
    UnknownEscrow = 1,
    /// The payee has armed reject mode to simulate a failing hook.
    Rejected = 2,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
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
#[contract]
pub struct PayeeCallback;

#[contractimpl]
impl PayeeCallback {
    /// Register `escrow_id` as an escrow this payee expects to receive from.
    pub fn register_escrow(env: Env, escrow_id: u64) {
        env.storage().persistent().set(&DataKey::Known(escrow_id), &true);
    }

    /// Arm/disarm reject mode. When armed, `on_escrow_released` fails with
    /// `Rejected`, which reverts the release atomically.
    pub fn set_reject(env: Env, reject: bool) {
        env.storage().persistent().set(&DataKey::RejectMode, &reject);
    }

    /// The last payout recorded by the hook: `(escrow_id, amount)`.
    pub fn last_payout(env: Env) -> (u64, i128) {
        (
            env.storage()
                .persistent()
                .get(&DataKey::LastId)
                .unwrap_or(0),
            env.storage()
                .persistent()
                .get(&DataKey::LastAmount)
                .unwrap_or(0),
        )
    }

    /// Total amount received across all payouts recorded by the hook.
    pub fn total_received(env: Env) -> i128 {
        env.storage()
            .persistent()
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
    pub fn on_escrow_released(
        env: Env,
        escrow_id: u64,
        amount: i128,
    ) -> Result<(), Error> {
        if !env.storage().persistent().has(&DataKey::Known(escrow_id)) {
            return Err(Error::UnknownEscrow);
        }
        if env
            .storage()
            .persistent()
            .get::<_, bool>(&DataKey::RejectMode)
            .unwrap_or(false)
        {
            return Err(Error::Rejected);
        }
        env.storage().persistent().set(&DataKey::LastId, &escrow_id);
        env.storage().persistent().set(&DataKey::LastAmount, &amount);
        let total = env
            .storage()
            .persistent()
            .get::<_, i128>(&DataKey::TotalReceived)
            .unwrap_or(0);
        env.storage()
            .persistent()
            .set(&DataKey::TotalReceived, &(total + amount));
        Ok(())
    }
}
