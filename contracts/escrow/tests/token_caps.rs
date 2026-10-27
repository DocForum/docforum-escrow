// Deploy-time immutable per-token escrow caps (issue #56, docs/adr/0013).

use docforum_escrow::{CreateItem, Error, EscrowContract, EscrowContractClient};
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{StellarAssetClient, TokenClient},
    Address, Env, Map, String, Vec,
};

fn create_token<'a>(env: &'a Env) -> (Address, TokenClient<'a>, StellarAssetClient<'a>) {
    let admin = Address::generate(env);
    let contract_id = env.register_stellar_asset_contract_v2(admin);
    (
        contract_id.address(),
        TokenClient::new(env, &contract_id.address()),
        StellarAssetClient::new(env, &contract_id.address()),
    )
}

fn register_with_cap(env: &Env, token: &Address, maximum: i128) -> Address {
    let mut caps = Map::new(env);
    caps.set(token.clone(), maximum);
    env.register(EscrowContract, (Vec::<Address>::new(env), caps))
}

fn try_create(
    env: &Env,
    client: &EscrowContractClient<'_>,
    token: &Address,
    payer: &Address,
    amount: i128,
) -> Result<u64, Error> {
    match client.try_create_escrow(
        payer,
        &Address::generate(env),
        token,
        &amount,
        &String::from_str(env, "cap-test"),
        &Address::generate(env),
        &None,
        &false,
        &None,
        &None,
        &None,
    ) {
        Ok(Ok(id)) => Ok(id),
        Err(Ok(e)) => Err(e),
        other => panic!("unexpected result: {other:?}"),
    }
}

#[test]
fn create_accepts_amount_at_cap_and_rejects_amount_over_cap() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, token_client, asset) = create_token(&env);
    let payer = Address::generate(&env);
    asset.mint(&payer, &1_000);
    let contract_id = register_with_cap(&env, &token, 300);
    let client = EscrowContractClient::new(&env, &contract_id);

    assert_eq!(try_create(&env, &client, &token, &payer, 300), Ok(0));
    assert_eq!(
        try_create(&env, &client, &token, &payer, 301),
        Err(Error::AmountCapExceeded)
    );
    // The rejected call moved nothing.
    assert_eq!(token_client.balance(&payer), 700);
}

#[test]
fn token_without_a_cap_entry_is_rejected_when_caps_are_configured() {
    let env = Env::default();
    env.mock_all_auths();
    let (capped, _, _) = create_token(&env);
    let (uncapped, _, uncapped_asset) = create_token(&env);
    let payer = Address::generate(&env);
    uncapped_asset.mint(&payer, &100);
    let contract_id = register_with_cap(&env, &capped, 1_000);
    let client = EscrowContractClient::new(&env, &contract_id);

    assert_eq!(
        try_create(&env, &client, &uncapped, &payer, 1),
        Err(Error::TokenCapNotConfigured)
    );
}

#[test]
fn empty_cap_map_preserves_uncapped_behavior() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _, asset) = create_token(&env);
    let payer = Address::generate(&env);
    asset.mint(&payer, &1_000_000);
    let contract_id = env.register(
        EscrowContract,
        (Vec::<Address>::new(&env), Map::<Address, i128>::new(&env)),
    );
    let client = EscrowContractClient::new(&env, &contract_id);

    assert_eq!(try_create(&env, &client, &token, &payer, 1_000_000), Ok(0));
}

#[test]
fn top_up_cannot_raise_an_escrow_above_its_cap() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, token_client, asset) = create_token(&env);
    let payer = Address::generate(&env);
    asset.mint(&payer, &1_000);
    let contract_id = register_with_cap(&env, &token, 500);
    let client = EscrowContractClient::new(&env, &contract_id);
    let id = try_create(&env, &client, &token, &payer, 300).unwrap();

    client.top_up(&id, &payer, &200);
    assert_eq!(
        client.try_top_up(&id, &payer, &1),
        Err(Ok(Error::AmountCapExceeded))
    );
    assert_eq!(client.get_escrow(&id).amount, 500);
    assert_eq!(token_client.balance(&payer), 500);
}

#[test]
fn batch_creation_checks_every_item_and_is_atomic() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, token_client, asset) = create_token(&env);
    let payer = Address::generate(&env);
    asset.mint(&payer, &1_000);
    let contract_id = register_with_cap(&env, &token, 200);
    let client = EscrowContractClient::new(&env, &contract_id);

    let item = |amount: i128| CreateItem {
        payee: Address::generate(&env),
        token: token.clone(),
        amount,
        condition_ref: String::from_str(&env, "batch-cap"),
        releaser: Address::generate(&env),
        refund_after: None,
    };
    let mut items = Vec::new(&env);
    items.push_back(item(200));
    items.push_back(item(201));

    assert_eq!(
        client.try_create_escrows(&payer, &items),
        Err(Ok(Error::AmountCapExceeded))
    );
    assert_eq!(token_client.balance(&payer), 1_000);
}

#[test]
fn pooled_funding_target_is_capped() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let (token, _, _) = create_token(&env);
    let contract_id = register_with_cap(&env, &token, 500);
    let client = EscrowContractClient::new(&env, &contract_id);
    let create = |target: i128| {
        client.try_create_pooled_escrow(
            &Address::generate(&env),
            &Address::generate(&env),
            &token,
            &target,
            &String::from_str(&env, "pooled-cap"),
            &Address::generate(&env),
            &2_000,
        )
    };

    assert!(create(500).is_ok());
    assert_eq!(create(501), Err(Ok(Error::AmountCapExceeded)));
}

#[test]
fn non_positive_cap_is_rejected_at_deployment() {
    let env = Env::default();
    let (token, _, _) = create_token(&env);
    let mut caps = Map::new(&env);
    caps.set(token, 0i128);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        env.register(EscrowContract, (Vec::<Address>::new(&env), caps))
    }));
    assert!(result.is_err(), "a zero cap must fail the constructor");
}
