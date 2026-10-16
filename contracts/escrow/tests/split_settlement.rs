use docforum_escrow::{EscrowContract, EscrowContractClient, EscrowStatus};
use soroban_sdk::{
    testutils::Address as _,
    token::{StellarAssetClient, TokenClient},
    Address, Env, String,
};

struct Fixture<'a> {
    client: EscrowContractClient<'a>,
    token: TokenClient<'a>,
    payer: Address,
    payee: Address,
    releaser: Address,
    id: u64,
}

fn setup(env: &Env) -> Fixture<'_> {
    env.mock_all_auths();
    let admin = Address::generate(env);
    let token_id = env.register_stellar_asset_contract_v2(admin).address();
    let token = TokenClient::new(env, &token_id);
    let asset = StellarAssetClient::new(env, &token_id);
    let payer = Address::generate(env);
    let payee = Address::generate(env);
    let releaser = Address::generate(env);
    asset.mint(&payer, &500);
    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(env, &contract_id);
    let id = client.create_escrow(
        &payer,
        &payee,
        &token_id,
        &300,
        &String::from_str(env, "split-test"),
        &releaser,
        &None,
    );
    Fixture { client, token, payer, payee, releaser, id }
}

#[test]
fn split_settlement_supports_zero_full_and_partial_payouts() {
    let env = Env::default();
    let zero = setup(&env);
    zero.client.settle(&zero.id, &zero.releaser, &0);
    assert_eq!(zero.token.balance(&zero.payee), 0);
    assert_eq!(zero.token.balance(&zero.payer), 500);
    assert_eq!(zero.client.get_status(&zero.id), EscrowStatus::Settled);

    let full = setup(&env);
    full.client.settle(&full.id, &full.releaser, &300);
    assert_eq!(full.token.balance(&full.payee), 300);
    assert_eq!(full.token.balance(&full.payer), 200);

    let partial = setup(&env);
    partial.client.settle(&partial.id, &partial.releaser, &120);
    assert_eq!(partial.token.balance(&partial.payee), 120);
    assert_eq!(partial.token.balance(&partial.payer), 380);
}

#[test]
fn split_settlement_rejects_amounts_outside_the_escrow_range() {
    let env = Env::default();
    let negative = setup(&env);
    assert!(negative.client.try_settle(&negative.id, &negative.releaser, &-1).is_err());

    let too_large = setup(&env);
    assert!(too_large.client.try_settle(&too_large.id, &too_large.releaser, &301).is_err());

    let overflow = setup(&env);
    assert!(overflow.client.try_settle(&overflow.id, &overflow.releaser, &i128::MAX).is_err());
}
