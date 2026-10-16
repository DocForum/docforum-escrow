// Phase E1 tests — create_escrow + get_status. Per AGENTS.md hard rule 2:
// contract logic changes need tests here before merge.
//
// release()/refund() are Phase E2 — see tests/release_refund.rs.

use docforum_escrow::{Error, EscrowContract, EscrowContractClient, EscrowStatus};
use soroban_sdk::{
    testutils::Address as _,
    token::{StellarAssetClient, TokenClient},
    Address, Env, Map, String,
};

fn setup<'a>(env: &Env) -> (Address, TokenClient<'a>, StellarAssetClient<'a>) {
    let admin = Address::generate(env);
    let contract_id = env.register_stellar_asset_contract_v2(admin);
    let token = TokenClient::new(env, &contract_id.address());
    let asset = StellarAssetClient::new(env, &contract_id.address());
    (contract_id.address(), token, asset)
}

fn register_contract(env: &Env, token: &Address, maximum: i128) -> Address {
    let mut maximum_amounts = Map::new(env);
    maximum_amounts.set(token.clone(), maximum);
    env.register(EscrowContract, (maximum_amounts,))
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

    let contract_id = register_contract(&env, &token_id, 1_000);
    let client = EscrowContractClient::new(&env, &contract_id);

    let escrow_id = client.create_escrow(
        &payer,
        &payee,
        &token_id,
        &300,
        &String::from_str(&env, "opaque-condition-ref"),
        &releaser,
        &None,
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

    let contract_id = register_contract(&env, &token_id, 1_000);
    let client = EscrowContractClient::new(&env, &contract_id);

    let first = client.create_escrow(&payer, &payee, &token_id, &100, &String::from_str(&env, "ref-a"), &releaser, &None);
    let second = client.create_escrow(&payer, &payee, &token_id, &100, &String::from_str(&env, "ref-b"), &releaser, &None);

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

    let contract_id = register_contract(&env, &token_id, 1_000);
    let client = EscrowContractClient::new(&env, &contract_id);

    let result = client.try_create_escrow(&payer, &payee, &token_id, &0, &String::from_str(&env, "ref"), &releaser, &None);
    assert!(result.is_err());
}

#[test]
fn get_status_errors_for_unknown_escrow() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(EscrowContract, (Map::<Address, i128>::new(&env),));
    let client = EscrowContractClient::new(&env, &contract_id);

    let result = client.try_get_status(&999);
    assert!(result.is_err());
}

#[test]
fn create_escrow_accepts_amount_at_token_cap_and_rejects_over_cap() {
    let env = Env::default();
    env.mock_all_auths();
    let (token_id, _token, asset) = setup(&env);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    asset.mint(&payer, &1_000);
    let contract_id = register_contract(&env, &token_id, 300);
    let client = EscrowContractClient::new(&env, &contract_id);

    let at_cap = client.create_escrow(
        &payer, &payee, &token_id, &300,
        &String::from_str(&env, "at-cap"), &releaser, &None,
    );
    let over_cap = client.try_create_escrow(
        &payer, &payee, &token_id, &301,
        &String::from_str(&env, "over-cap"), &releaser, &None,
    );

    assert_eq!(at_cap, 0);
    assert_eq!(over_cap, Err(Ok(Error::AmountCapExceeded)));
}

#[test]
fn token_without_a_deployment_cap_is_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let (token_id, _token, asset) = setup(&env);
    let payer = Address::generate(&env);
    asset.mint(&payer, &1_000);
    let contract_id = env.register(EscrowContract, (Map::<Address, i128>::new(&env),));
    let client = EscrowContractClient::new(&env, &contract_id);

    let result = client.try_create_escrow(
        &payer,
        &Address::generate(&env),
        &token_id,
        &1,
        &String::from_str(&env, "uncapped-token"),
        &Address::generate(&env),
        &None,
    );

    assert_eq!(result, Err(Ok(Error::TokenCapNotConfigured)));
}

#[test]
fn top_up_cannot_raise_funded_escrow_above_token_cap() {
    let env = Env::default();
    env.mock_all_auths();
    let (token_id, token, asset) = setup(&env);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    asset.mint(&payer, &1_000);
    let contract_id = register_contract(&env, &token_id, 500);
    let client = EscrowContractClient::new(&env, &contract_id);
    let escrow_id = client.create_escrow(
        &payer, &payee, &token_id, &300,
        &String::from_str(&env, "top-up"), &releaser, &None,
    );

    client.top_up(&escrow_id, &payer, &200);
    let over_cap = client.try_top_up(&escrow_id, &payer, &1);

    assert_eq!(client.get_escrow(&escrow_id).amount, 500);
    assert_eq!(over_cap, Err(Ok(Error::AmountCapExceeded)));
    assert_eq!(token.balance(&payer), 500);
}
