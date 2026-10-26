// Deploy-time immutable token allowlist (issue #36, threat model T5).

use docforum_escrow::{EscrowContract, EscrowContractClient};
use soroban_sdk::{
    testutils::Address as _,
    token::{StellarAssetClient, TokenClient},
    Address, Env, String, Vec,
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

fn create_escrow(
    env: &Env,
    client: &EscrowContractClient<'_>,
    token: &Address,
    payer: &Address,
) -> u64 {
    client.create_escrow(
        payer,
        &Address::generate(env),
        token,
        &100,
        &String::from_str(env, "allowlist-test"),
        &Address::generate(env),
        &None,
        &false,
        &None,
    )
}

#[test]
fn configured_allowlist_accepts_listed_token_and_rejects_unlisted_token() {
    let env = Env::default();
    env.mock_all_auths();
    let (allowed_token, _, allowed_asset) = create_token(&env);
    let (unlisted_token, _, unlisted_asset) = create_token(&env);
    let payer = Address::generate(&env);
    allowed_asset.mint(&payer, &500);
    unlisted_asset.mint(&payer, &500);

    let mut allowlist = Vec::new(&env);
    allowlist.push_back(allowed_token.clone());
    let contract_id = env.register(EscrowContract, (allowlist, soroban_sdk::Map::<soroban_sdk::Address, i128>::new(&env)));
    let client = EscrowContractClient::new(&env, &contract_id);

    assert_eq!(create_escrow(&env, &client, &allowed_token, &payer), 0);
    assert!(client
        .try_create_escrow(
            &payer,
            &Address::generate(&env),
            &unlisted_token,
            &100,
            &String::from_str(&env, "allowlist-test"),
            &Address::generate(&env),
            &None,
            &false,
            &None,
        )
        .is_err());
}

#[test]
fn empty_allowlist_preserves_open_token_behavior() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _, asset) = create_token(&env);
    let payer = Address::generate(&env);
    asset.mint(&payer, &100);

    let contract_id = env.register(EscrowContract, (Vec::<Address>::new(&env), soroban_sdk::Map::<soroban_sdk::Address, i128>::new(&env)));
    let client = EscrowContractClient::new(&env, &contract_id);

    assert_eq!(create_escrow(&env, &client, &token, &payer), 0);
}
