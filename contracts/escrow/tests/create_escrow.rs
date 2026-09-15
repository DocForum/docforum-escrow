// Phase E1 tests — create_escrow + get_status. Per AGENTS.md hard rule 2:
// contract logic changes need tests here before merge.
//
// release()/refund() are Phase E2 — see tests/release_refund.rs.

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

#[test]
fn create_escrow_locks_funds_and_reports_funded() {
    let env = Env::default();
    env.mock_all_auths();

    let (token_id, token, asset) = setup(&env);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    asset.mint(&payer, &1_000);

    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);

    let escrow_id = client.create_escrow(
        &payer,
        &payee,
        &token_id,
        &300,
        &String::from_str(&env, "opaque-condition-ref"),
        &releaser,
    );

    assert_eq!(escrow_id, 0);
    assert_eq!(token.balance(&payer), 700);
    assert_eq!(token.balance(&contract_id), 300);
    assert_eq!(client.get_status(&escrow_id), EscrowStatus::Funded);
}

#[test]
fn create_escrow_assigns_sequential_ids() {
    let env = Env::default();
    env.mock_all_auths();

    let (token_id, _token, asset) = setup(&env);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    asset.mint(&payer, &1_000);

    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);

    let first = client.create_escrow(&payer, &payee, &token_id, &100, &String::from_str(&env, "ref-a"), &releaser);
    let second = client.create_escrow(&payer, &payee, &token_id, &100, &String::from_str(&env, "ref-b"), &releaser);

    assert_eq!(first, 0);
    assert_eq!(second, 1);
}

#[test]
fn create_escrow_rejects_non_positive_amount() {
    let env = Env::default();
    env.mock_all_auths();

    let (token_id, _token, _asset) = setup(&env);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);

    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);

    let result = client.try_create_escrow(&payer, &payee, &token_id, &0, &String::from_str(&env, "ref"), &releaser);
    assert!(result.is_err());
}

#[test]
fn get_status_errors_for_unknown_escrow() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);

    let result = client.try_get_status(&999);
    assert!(result.is_err());
}
