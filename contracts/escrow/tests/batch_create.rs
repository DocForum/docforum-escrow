use docforum_escrow::{
    EscrowContract, EscrowContractClient, EscrowParams, EscrowStatus, MAX_BATCH_SIZE,
};
use soroban_sdk::{
    testutils::Address as _,
    token::{StellarAssetClient, TokenClient},
    Address, Env, String, Vec,
};

fn item(env: &Env, token: &Address, amount: i128) -> EscrowParams {
    EscrowParams {
        payee: Address::generate(env),
        token: token.clone(),
        amount,
        condition_ref: String::from_str(env, "batch-item"),
        releaser: Address::generate(env),
        refund_after: None,
    }
}

#[test]
fn batch_creation_returns_sequential_ids_and_checks_mixed_tokens() {
    let env = Env::default();
    env.mock_all_auths();
    let payer = Address::generate(&env);
    let token_a = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    let token_b = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    StellarAssetClient::new(&env, &token_a).mint(&payer, &1_000);
    StellarAssetClient::new(&env, &token_b).mint(&payer, &1_000);
    let contract_id = env.register(EscrowContract, (Vec::<Address>::new(&env),));
    let client = EscrowContractClient::new(&env, &contract_id);
    let mut items = Vec::new(&env);
    items.push_back(item(&env, &token_a, 100));
    items.push_back(item(&env, &token_b, 200));
    items.push_back(item(&env, &token_a, 300));

    let ids = client.create_escrows(&payer, &items);
    assert_eq!(ids.len(), 3);
    assert_eq!(ids.get(0), Some(0));
    assert_eq!(ids.get(1), Some(1));
    assert_eq!(ids.get(2), Some(2));
    assert_eq!(client.get_escrow(&ids.get(1).unwrap()).amount, 200);
    assert_eq!(
        client.get_status(&ids.get(2).unwrap()),
        EscrowStatus::Funded
    );
    assert_eq!(TokenClient::new(&env, &token_a).balance(&contract_id), 400);
    assert_eq!(TokenClient::new(&env, &token_b).balance(&contract_id), 200);
}

#[test]
fn invalid_item_reports_index_and_rolls_back_all_funding() {
    let env = Env::default();
    env.mock_all_auths();
    let payer = Address::generate(&env);
    let token_id = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    let token = TokenClient::new(&env, &token_id);
    StellarAssetClient::new(&env, &token_id).mint(&payer, &1_000);
    let contract_id = env.register(EscrowContract, (Vec::<Address>::new(&env),));
    let client = EscrowContractClient::new(&env, &contract_id);
    let mut items = Vec::new(&env);
    items.push_back(item(&env, &token_id, 100));
    items.push_back(item(&env, &token_id, 0));
    let result = client.try_create_escrows(&payer, &items);
    assert!(result.is_err());
    assert_eq!(token.balance(&payer), 1_000);
    assert_eq!(token.balance(&contract_id), 0);
    assert!(client.try_get_escrow(&0).is_err());
}

#[test]
fn batch_size_is_bounded_and_empty_batches_are_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let payer = Address::generate(&env);
    let token_id = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    let contract_id = env.register(EscrowContract, (Vec::<Address>::new(&env),));
    let client = EscrowContractClient::new(&env, &contract_id);
    assert!(client.try_create_escrows(&payer, &Vec::new(&env)).is_err());
    let mut too_many = Vec::new(&env);
    for _ in 0..=MAX_BATCH_SIZE {
        too_many.push_back(item(&env, &token_id, 1));
    }
    assert!(client.try_create_escrows(&payer, &too_many).is_err());
}
