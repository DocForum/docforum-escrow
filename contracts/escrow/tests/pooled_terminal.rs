use docforum_escrow::{EscrowContract, EscrowContractClient, EscrowStatus};
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    Address, Env, String, Vec,
};

const CREATED_AT: u64 = 1_000;
const DEADLINE: u64 = 1_100;

struct Fixture<'a> {
    client: EscrowContractClient<'a>,
    id: u64,
    token: Address,
    contract_id: Address,
}

fn setup(env: &Env, target: i128) -> Fixture<'_> {
    env.mock_all_auths();
    env.ledger().set_timestamp(CREATED_AT);
    let token = env
        .register_stellar_asset_contract_v2(Address::generate(env))
        .address();
    let creator = Address::generate(env);
    let contract_id = env.register(
        EscrowContract,
        (Vec::<Address>::new(env), Address::generate(env)),
    );
    let client = EscrowContractClient::new(env, &contract_id);
    let id = client.create_pooled_escrow(
        &creator,
        &Address::generate(env),
        &token,
        &target,
        &String::from_str(env, "pooled-terminal"),
        &Address::generate(env),
        &DEADLINE,
    );
    Fixture {
        client,
        id,
        token,
        contract_id,
    }
}

#[test]
fn zero_contribution_failed_round_can_be_closed_permissionlessly() {
    let env = Env::default();
    let f = setup(&env, 100);
    env.ledger().set_timestamp(DEADLINE);

    f.client.close_failed_round(&f.id);

    assert_eq!(f.client.get_status(&f.id), EscrowStatus::Refunded);
    assert!(f.client.try_get_escrow(&f.id).is_err());
    assert_eq!(f.client.solvency(&f.token), (0, 0));
}

#[test]
fn final_contributor_claim_closes_failed_round() {
    let env = Env::default();
    let f = setup(&env, 100);
    let contributor = Address::generate(&env);
    soroban_sdk::token::StellarAssetClient::new(&env, &f.token).mint(&contributor, &30);
    f.client.contribute(&f.id, &contributor, &30);
    env.ledger().set_timestamp(DEADLINE);

    f.client.claim_refund(&f.id, &contributor);

    assert_eq!(f.client.get_status(&f.id), EscrowStatus::Refunded);
    assert!(f.client.try_get_escrow(&f.id).is_err());
    assert_eq!(f.client.solvency(&f.token), (0, 0));
    assert_eq!(soroban_sdk::token::TokenClient::new(&env, &f.token).balance(&contributor), 30);
    assert_eq!(soroban_sdk::token::TokenClient::new(&env, &f.token).balance(&f.contract_id), 0);
}
