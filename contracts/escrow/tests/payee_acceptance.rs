use docforum_escrow::{EscrowContract, EscrowContractClient, EscrowStatus};
use soroban_sdk::{
    testutils::Address as _,
    token::{StellarAssetClient, TokenClient},
    Address, Env, String,
};

struct Fixture<'a> {
    client: EscrowContractClient<'a>,
    token: TokenClient<'a>,
    contract_id: Address,
    payer: Address,
    payee: Address,
    releaser: Address,
    id: u64,
}

fn setup(env: &Env) -> Fixture<'_> {
    env.mock_all_auths();
    let token_id = env
        .register_stellar_asset_contract_v2(Address::generate(env))
        .address();
    let token = TokenClient::new(env, &token_id);
    let asset = StellarAssetClient::new(env, &token_id);
    let payer = Address::generate(env);
    let payee = Address::generate(env);
    let releaser = Address::generate(env);
    asset.mint(&payer, &500);
    let contract_id = env.register(EscrowContract, (soroban_sdk::Vec::<Address>::new(env),));
    let client = EscrowContractClient::new(env, &contract_id);
    let id = client.create_escrow_with_acceptance(
        &payer,
        &payee,
        &token_id,
        &300,
        &String::from_str(env, "acceptance-test"),
        &releaser,
        &None,
        &true,
        &None,
    );
    Fixture {
        client,
        token,
        contract_id,
        payer,
        payee,
        releaser,
        id,
    }
}

#[test]
fn required_acceptance_blocks_release_until_payee_accepts() {
    let env = Env::default();
    let f = setup(&env);
    assert!(f.client.try_release(&f.id, &f.releaser).is_err());
    assert_eq!(f.client.get_status(&f.id), EscrowStatus::Funded);
    assert_eq!(f.token.balance(&f.contract_id), 300);

    f.client.accept(&f.id, &f.payee);
    let data = f.client.get_escrow(&f.id);
    assert!(data.requires_acceptance);
    assert!(data.accepted_at.is_some());
    assert!(f.client.try_accept(&f.id, &f.payee).is_err());
    f.client.release(&f.id, &f.releaser);
    assert_eq!(f.token.balance(&f.payee), 300);
}

#[test]
fn acceptance_requires_the_payee_and_only_works_while_funded() {
    let env = Env::default();
    let f = setup(&env);
    let stranger = Address::generate(&env);
    assert!(f.client.try_accept(&f.id, &stranger).is_err());
    f.client.refund(&f.id, &f.releaser);
    assert!(f.client.try_accept(&f.id, &f.payee).is_err());
}

#[test]
fn legacy_creation_keeps_acceptance_opt_out() {
    let env = Env::default();
    env.mock_all_auths();
    let token_id = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    let token = TokenClient::new(&env, &token_id);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    StellarAssetClient::new(&env, &token_id).mint(&payer, &100);
    let contract_id = env.register(EscrowContract, (soroban_sdk::Vec::<Address>::new(&env),));
    let client = EscrowContractClient::new(&env, &contract_id);
    let id = client.create_escrow(
        &payer,
        &payee,
        &token_id,
        &100,
        &String::from_str(&env, "legacy"),
        &releaser,
        &None,
        &false,
        &None,
        &None,
        &None,
    );
    let data = client.get_escrow(&id);
    assert!(!data.requires_acceptance);
    assert_eq!(data.accepted_at, None);
    client.release(&id, &releaser);
    assert_eq!(token.balance(&payee), 100);
}
