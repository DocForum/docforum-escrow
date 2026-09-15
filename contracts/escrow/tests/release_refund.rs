// Phase E2 tests — release() and refund(). Per AGENTS.md hard rule 2:
// payment logic changes need tests here before merge, not a follow-up.
//
// Auth model under test: only the escrow's `releaser` (set at
// create_escrow time — docs/adr/0002) may call release/refund, and only
// while the escrow is still Funded. See issues #2 and #3.

use docforum_escrow::{EscrowContract, EscrowContractClient, EscrowStatus};
use soroban_sdk::{
    testutils::Address as _,
    token::{StellarAssetClient, TokenClient},
    Address, Env, String,
};

fn setup<'a>(env: &Env) -> (Address, TokenClient<'a>, StellarAssetClient<'a>) {
    let admin = Address::generate(env);
    let contract_id = env.register_stellar_asset_contract_v2(admin);
    let token = TokenClient::new(env, &contract_id.address());
    let asset = StellarAssetClient::new(env, &contract_id.address());
    (contract_id.address(), token, asset)
}

struct Fixture<'a> {
    client: EscrowContractClient<'a>,
    token: TokenClient<'a>,
    payer: Address,
    payee: Address,
    releaser: Address,
    escrow_id: u64,
}

fn fund_escrow(env: &Env, amount: i128) -> Fixture<'_> {
    let (token_id, token, asset) = setup(env);
    let payer = Address::generate(env);
    let payee = Address::generate(env);
    let releaser = Address::generate(env);
    asset.mint(&payer, &1_000);

    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(env, &contract_id);

    let escrow_id = client.create_escrow(
        &payer,
        &payee,
        &token_id,
        &amount,
        &String::from_str(env, "opaque-condition-ref"),
        &releaser,
    );

    Fixture { client, token, payer, payee, releaser, escrow_id }
}

// --- release() ---

#[test]
fn release_transfers_funds_to_payee_and_marks_released() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund_escrow(&env, 300);

    f.client.release(&f.escrow_id, &f.releaser);

    assert_eq!(f.token.balance(&f.payee), 300);
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Released);
}

#[test]
fn release_rejects_unauthorized_caller() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund_escrow(&env, 300);
    let stranger = Address::generate(&env);

    let result = f.client.try_release(&f.escrow_id, &stranger);

    assert!(result.is_err());
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Funded);
    assert_eq!(f.token.balance(&f.payee), 0);
}

#[test]
fn release_rejects_double_release() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund_escrow(&env, 300);

    f.client.release(&f.escrow_id, &f.releaser);
    let second = f.client.try_release(&f.escrow_id, &f.releaser);

    assert!(second.is_err());
    assert_eq!(f.token.balance(&f.payee), 300); // unchanged by the second attempt
}

// --- refund() ---

#[test]
fn refund_transfers_funds_back_to_payer_and_marks_refunded() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund_escrow(&env, 300);

    f.client.refund(&f.escrow_id, &f.releaser);

    assert_eq!(f.token.balance(&f.payer), 1_000); // full 1,000 minted, 300 returned
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Refunded);
}

#[test]
fn refund_rejects_unauthorized_caller() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund_escrow(&env, 300);
    let stranger = Address::generate(&env);

    let result = f.client.try_refund(&f.escrow_id, &stranger);

    assert!(result.is_err());
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Funded);
}

#[test]
fn refund_rejects_after_release() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund_escrow(&env, 300);

    f.client.release(&f.escrow_id, &f.releaser);
    let refund_attempt = f.client.try_refund(&f.escrow_id, &f.releaser);

    assert!(refund_attempt.is_err());
    assert_eq!(f.token.balance(&f.payer), 700); // never got the 300 back
}

#[test]
fn release_rejects_after_refund() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund_escrow(&env, 300);

    f.client.refund(&f.escrow_id, &f.releaser);
    let release_attempt = f.client.try_release(&f.escrow_id, &f.releaser);

    assert!(release_attempt.is_err());
    assert_eq!(f.token.balance(&f.payee), 0); // never got paid
}
