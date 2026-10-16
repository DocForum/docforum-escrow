// Phase E5 milestone escrow tests (issue #21). These pin the invariant
// that each fixed tranche is paid at most once and total payouts never
// exceed the amount funded.

use docforum_escrow::{EscrowContract, EscrowContractClient, EscrowStatus};
use soroban_sdk::{
    testutils::Address as _,
    token::{StellarAssetClient, TokenClient},
    Address, Env, String, Vec,
};

struct Fixture<'a> {
    client: EscrowContractClient<'a>,
    token: TokenClient<'a>,
    payer: Address,
    payee: Address,
    releaser: Address,
    escrow_id: u64,
}

fn setup<'a>(env: &'a Env, milestones: &[i128]) -> Fixture<'a> {
    let admin = Address::generate(env);
    let token_id = env.register_stellar_asset_contract_v2(admin).address();
    let token = TokenClient::new(env, &token_id);
    let asset = StellarAssetClient::new(env, &token_id);
    let payer = Address::generate(env);
    let payee = Address::generate(env);
    let releaser = Address::generate(env);
    asset.mint(&payer, &1_000);

    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(env, &contract_id);
    let mut schedule = Vec::new(env);
    let mut amount = 0_i128;
    for tranche in milestones {
        schedule.push_back(*tranche);
        amount += *tranche;
    }
    let escrow_id = client.create_milestone_escrow(
        &payer,
        &payee,
        &token_id,
        &amount,
        &String::from_str(env, "milestone-condition"),
        &releaser,
        &None,
        &schedule,
    );
    Fixture {
        client,
        token,
        payer,
        payee,
        releaser,
        escrow_id,
    }
}

#[test]
fn releases_out_of_order_and_never_pays_a_tranche_twice() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env, &[200, 300, 500]);

    f.client.release_milestone(&f.escrow_id, &2, &f.releaser);
    assert_eq!(f.token.balance(&f.payee), 500);
    assert_eq!(
        f.client.get_status(&f.escrow_id),
        EscrowStatus::PartiallyReleased
    );

    assert!(f
        .client
        .try_release_milestone(&f.escrow_id, &2, &f.releaser)
        .is_err());
    f.client.release_milestone(&f.escrow_id, &0, &f.releaser);
    f.client.release_milestone(&f.escrow_id, &1, &f.releaser);

    assert_eq!(f.token.balance(&f.payee), 1_000);
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Released);
    assert!(f
        .client
        .try_release_milestone(&f.escrow_id, &0, &f.releaser)
        .is_err());
    assert_eq!(f.token.balance(&f.payee), 1_000);
}

#[test]
fn refund_after_partial_release_returns_only_the_unreleased_remainder() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env, &[250, 250, 500]);

    f.client.release_milestone(&f.escrow_id, &1, &f.releaser);
    f.client.refund(&f.escrow_id, &f.releaser);

    assert_eq!(f.token.balance(&f.payee), 250);
    assert_eq!(f.token.balance(&f.payer), 750);
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Refunded);
    assert!(f
        .client
        .try_release_milestone(&f.escrow_id, &0, &f.releaser)
        .is_err());
}

#[test]
fn multi_milestone_escrow_cannot_be_released_through_legacy_release() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env, &[400, 600]);

    assert!(f.client.try_release(&f.escrow_id, &f.releaser).is_err());
    assert_eq!(f.token.balance(&f.payee), 0);
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Funded);
}

#[test]
fn rejects_invalid_schedule_without_locking_funds() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(admin).address();
    let token = TokenClient::new(&env, &token_id);
    let asset = StellarAssetClient::new(&env, &token_id);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    asset.mint(&payer, &1_000);
    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);
    let mut schedule = Vec::new(&env);
    schedule.push_back(400_i128);
    schedule.push_back(0_i128);

    let result = client.try_create_milestone_escrow(
        &payer,
        &payee,
        &token_id,
        &400,
        &String::from_str(&env, "invalid-schedule"),
        &releaser,
        &None,
        &schedule,
    );
    assert!(result.is_err());
    assert_eq!(token.balance(&payer), 1_000);
    assert_eq!(token.balance(&contract_id), 0);
    assert!(client.try_get_status(&0).is_err());
}
