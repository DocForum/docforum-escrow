// Phase E1 tests — create_escrow + get_status. Per AGENTS.md hard rule 2:
// contract logic changes need tests here before merge.
//
// release()/refund() are Phase E2 — see tests/release_refund.rs.
// Phase E5/E6 — split payouts and protocol fee support.

use docforum_escrow::{EscrowContract, EscrowContractClient, EscrowStatus, Recipient};
use soroban_sdk::{
    testutils::Address as _,
    token::{StellarAssetClient, TokenClient},
    Address, Env, String, Vec,
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
        &None,
        &None,
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

    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);

    let first = client.create_escrow(&payer, &payee, &token_id, &100, &String::from_str(&env, "ref-a"), &releaser, &None, &None, &None);
    let second = client.create_escrow(&payer, &payee, &token_id, &100, &String::from_str(&env, "ref-b"), &releaser, &None, &None, &None);

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

    let result = client.try_create_escrow(&payer, &payee, &token_id, &0, &String::from_str(&env, "ref"), &releaser, &None, &None, &None);
    assert!(result.is_err());
}

#[test]
fn create_escrow_with_splits_and_fee_locks_funds() {
    let env = Env::default();
    env.mock_all_auths();

    let (token_id, token, asset) = setup(&env);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    let r1 = Address::generate(&env);
    let r2 = Address::generate(&env);
    asset.mint(&payer, &1_000);

    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);

    let mut splits = Vec::new(&env);
    splits.push_back(Recipient { address: r1.clone(), bps: 6_000 });
    splits.push_back(Recipient { address: r2.clone(), bps: 4_000 });

    let escrow_id = client.create_escrow(
        &payer,
        &payee,
        &token_id,
        &300,
        &String::from_str(&env, "split-ref"),
        &releaser,
        &None,
        &Some(splits),
        &Some(100),
    );

    assert_eq!(escrow_id, 0);
    assert_eq!(token.balance(&payer), 700);
    assert_eq!(token.balance(&contract_id), 300);
    assert_eq!(client.get_status(&escrow_id), EscrowStatus::Funded);
}

#[test]
fn create_escrow_rejects_splits_not_summing_to_10000_bps() {
    let env = Env::default();
    env.mock_all_auths();

    let (token_id, _token, asset) = setup(&env);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    let r1 = Address::generate(&env);
    asset.mint(&payer, &1_000);

    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);

    let mut splits = Vec::new(&env);
    splits.push_back(Recipient { address: r1, bps: 9_999 });

    let result = client.try_create_escrow(
        &payer,
        &payee,
        &token_id,
        &300,
        &String::from_str(&env, "bad-split"),
        &releaser,
        &None,
        &Some(splits),
        &None,
    );
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
