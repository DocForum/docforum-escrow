// Phase E5 tests — transfer_payee().
//
// Invariant under test: only the current payee may reassign the payout
// destination; no other party (payer, releaser, stranger) may redirect
// funds. After a successful transfer, release sends funds to the new
// address — and refund still goes back to the payer.
//
// transfer_payee is only valid while Funded. Rejected targets:
//   - the contract's own address
//   - the payer's address

use docforum_escrow::{EscrowContract, EscrowContractClient, EscrowStatus};
use soroban_sdk::{
    testutils::Address as _,
    token::{StellarAssetClient, TokenClient},
    Address, Env, String, Vec,
};

struct Fixture<'a> {
    client: EscrowContractClient<'a>,
    token: TokenClient<'a>,
    payer: Address,
    payee: Address,
    releaser: Address,
    contract_id: Address,
    escrow_id: u64,
}

fn setup(env: &Env) -> Fixture<'_> {
    env.mock_all_auths();

    let token_contract = env.register_stellar_asset_contract_v2(Address::generate(env));
    let token_id = token_contract.address();
    let token = TokenClient::new(env, &token_id);
    let asset = StellarAssetClient::new(env, &token_id);

    let payer = Address::generate(env);
    let payee = Address::generate(env);
    let releaser = Address::generate(env);
    asset.mint(&payer, &1_000);

    let contract_id = env.register(EscrowContract, (Vec::<Address>::new(env),));
    let client = EscrowContractClient::new(env, &contract_id);

    let escrow_id = client.create_escrow(
        &payer,
        &payee,
        &token_id,
        &500,
        &String::from_str(env, "opaque-condition-ref"),
        &releaser,
        &None,
        &false,
        &None,
        &None,
        &None,
    );

    Fixture {
        client,
        token,
        payer,
        payee,
        releaser,
        contract_id,
        escrow_id,
    }
}

// --- happy path ---

#[test]
fn transfer_payee_updates_stored_payee() {
    let env = Env::default();
    let f = setup(&env);
    let new_payee = Address::generate(&env);

    f.client
        .transfer_payee(&f.escrow_id, &f.payee, &new_payee);

    let data = f.client.get_escrow(&f.escrow_id);
    assert_eq!(data.payee, new_payee);
    assert_eq!(data.status, EscrowStatus::Funded);
}

#[test]
fn release_after_transfer_pays_new_payee_not_old() {
    let env = Env::default();
    let f = setup(&env);
    let new_payee = Address::generate(&env);

    f.client
        .transfer_payee(&f.escrow_id, &f.payee, &new_payee);
    f.client.release(&f.escrow_id, &f.releaser);

    assert_eq!(f.token.balance(&new_payee), 500);
    assert_eq!(f.token.balance(&f.payee), 0); // old payee gets nothing
    assert_eq!(
        f.client.get_status(&f.escrow_id),
        EscrowStatus::Released
    );
}

#[test]
fn refund_after_transfer_still_returns_to_payer() {
    let env = Env::default();
    let f = setup(&env);
    let new_payee = Address::generate(&env);

    f.client
        .transfer_payee(&f.escrow_id, &f.payee, &new_payee);
    f.client.refund(&f.escrow_id, &f.releaser);

    assert_eq!(f.token.balance(&f.payer), 1_000); // full refund
    assert_eq!(f.token.balance(&new_payee), 0);
    assert_eq!(
        f.client.get_status(&f.escrow_id),
        EscrowStatus::Refunded
    );
}

#[test]
fn payee_can_transfer_multiple_times_before_release() {
    let env = Env::default();
    let f = setup(&env);
    let payee_b = Address::generate(&env);
    let payee_c = Address::generate(&env);

    f.client
        .transfer_payee(&f.escrow_id, &f.payee, &payee_b);
    f.client
        .transfer_payee(&f.escrow_id, &payee_b, &payee_c);
    f.client.release(&f.escrow_id, &f.releaser);

    assert_eq!(f.token.balance(&payee_c), 500);
    assert_eq!(f.token.balance(&f.payee), 0);
    assert_eq!(f.token.balance(&payee_b), 0);
}

// --- auth ---

#[test]
fn transfer_payee_rejects_stranger() {
    let env = Env::default();
    let f = setup(&env);
    let stranger = Address::generate(&env);
    let new_payee = Address::generate(&env);

    let result = f
        .client
        .try_transfer_payee(&f.escrow_id, &stranger, &new_payee);

    assert!(result.is_err());
    // payee unchanged
    assert_eq!(f.client.get_escrow(&f.escrow_id).payee, f.payee);
}

#[test]
fn transfer_payee_rejects_payer_acting_as_current_payee() {
    let env = Env::default();
    let f = setup(&env);
    let new_payee = Address::generate(&env);

    // The payer is not the current payee — even if they try to claim it.
    let result = f
        .client
        .try_transfer_payee(&f.escrow_id, &f.payer, &new_payee);

    assert!(result.is_err());
    assert_eq!(f.client.get_escrow(&f.escrow_id).payee, f.payee);
}

#[test]
fn transfer_payee_rejects_releaser_acting_as_current_payee() {
    let env = Env::default();
    let f = setup(&env);
    let new_payee = Address::generate(&env);

    let result = f
        .client
        .try_transfer_payee(&f.escrow_id, &f.releaser, &new_payee);

    assert!(result.is_err());
    assert_eq!(f.client.get_escrow(&f.escrow_id).payee, f.payee);
}

// --- rejected new_payee targets ---

#[test]
fn transfer_payee_rejects_contract_address_as_new_payee() {
    let env = Env::default();
    let f = setup(&env);

    // new_payee == the contract's own address is rejected — it can never
    // sign to claim a payout, so funds would be permanently locked.
    let result = f
        .client
        .try_transfer_payee(&f.escrow_id, &f.payee, &f.contract_id);

    assert!(result.is_err());
    assert_eq!(f.client.get_escrow(&f.escrow_id).payee, f.payee);
}

#[test]
fn transfer_payee_rejects_payer_as_new_payee() {
    let env = Env::default();
    let f = setup(&env);

    // new_payee == payer is rejected: it would let the payer claw back
    // the escrow via a release (bypassing refund's auth), undermining
    // the payee's claim. Even a colluding current_payee cannot do this.
    let result = f
        .client
        .try_transfer_payee(&f.escrow_id, &f.payee, &f.payer);

    assert!(result.is_err());
    assert_eq!(f.client.get_escrow(&f.escrow_id).payee, f.payee);
}

// --- state checks ---

#[test]
fn transfer_payee_rejects_after_release() {
    let env = Env::default();
    let f = setup(&env);
    let new_payee = Address::generate(&env);

    f.client.release(&f.escrow_id, &f.releaser);
    let result = f
        .client
        .try_transfer_payee(&f.escrow_id, &f.payee, &new_payee);

    assert!(result.is_err());
    assert_eq!(
        f.client.get_status(&f.escrow_id),
        EscrowStatus::Released
    );
}

#[test]
fn transfer_payee_rejects_after_refund() {
    let env = Env::default();
    let f = setup(&env);
    let new_payee = Address::generate(&env);

    f.client.refund(&f.escrow_id, &f.releaser);
    let result = f
        .client
        .try_transfer_payee(&f.escrow_id, &f.payee, &new_payee);

    assert!(result.is_err());
    assert_eq!(
        f.client.get_status(&f.escrow_id),
        EscrowStatus::Refunded
    );
}

#[test]
fn transfer_payee_rejects_unknown_escrow_id() {
    let env = Env::default();
    let f = setup(&env);
    let new_payee = Address::generate(&env);

    let result = f
        .client
        .try_transfer_payee(&999u64, &f.payee, &new_payee);

    assert!(result.is_err());
}
