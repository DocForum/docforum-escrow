//! Example contract demonstrating cross-contract calls into the escrow.
///
/// This contract shows how another Soroban contract (e.g. a marketplace, DAO, or
/// vault) can create and release an escrow using the published `contractclient`
/// from `escrop-interface` instead of copy-pasting the WASM.
///
/// ## Auth requirements for contract-to-contract calls
///
/// The escrop contract requires the `payer` to authorize the funding transfer
/// and the `releaser` to authorize the release. When a contract calls the
/// escrow cross-contract, the calling contract must be the authorized party:
///
/// - If the calling contract is the payer, it must have been authorized by
///   the underlying account (e.g. via `require_auth`) and the escrow must
///   trust it as the payer address.
/// - If the calling contract is the releaser, it must be the address recorded
///   as the releaser in the escrow data.
///
/// In other words, the address passed as `payer` or `releaser` must equal the
/// calling contract's address for the auth check inside the escrow to pass.
#![no_std]

use escrop_interface::{EscrowClient, EscrowData, EscrowStatus, Error};
use sorban_sdk::{address::Address, env: Env, symbol_short!, into_val, val::Val};

/// Example contract that wraps escrow creation and release.
#[sorban_contract]
pub struct ExampleContract;

#[sorban_contractimpl]
impl ExampleContract {
    /// Create an escrow by calling into the escrow contract.
    ///
    /// The caller of this function must be the payer and must have
    /// authorized this contract to spend on its behalf. The address passed
    /// as `payer` is the calling contract address recorded in the escrow.
    pub fn create_escrow(
        env: Env,
        escrow_contract: Address,
        payer: Address,
        releaser: Address,
        amount: i128,
    ) -> Result<u32, Error> {
        let client = EscrowClient::new(&env, &escrow_contract);
        client.create_escrow(&payer, &releaser, &amount)
    }

    /// Release an existing escrow by calling into the escrow contract.
    ///
    /// The calling contract must be the releaser recorded in the escrow.
    pub fn release_escrow(
        env: Env,
        escrow_contract: Address,
        escrow_id: u32,
    ) -> Result<(), Error> {
        let client = EscrowClient::new(&env, &escrow_contract);
        client.release_escrow(&escrow_id)
    }

    /// Fetch escrow data through the interface client.
    pub fn get_escrow(env: Env, escrow_contract: Address, escrow_id: u32) -> Option<EscrowData> {
        let client = EscrowClient::new(&env, &escrow_contract);
        client.get_escrow(&escrow_id)
    }

    /// Return the status of an escrow through the interface client.
    pub fn get_status(env: Env, escrow_contract: Address, escrow_id: u32) -> Option<EscrowStatus> {
        let client = EscrowClient::new(&env, &escrow_contract);
        client.get_status(&escrow_id)
    }
}
