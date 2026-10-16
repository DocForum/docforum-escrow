use docforum_escrow::{DisputeOutcome, EscrowContract, EscrowContractClient, EscrowStatus};
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
    arbiter: Address,
    escrow_id: u64,
}

fn setup(env: &Env, with_arbiter: bool) -> Fixture<'_> {
    let admin = Address::generate(env);
    let token_id = env.register_stellar_asset_contract_v2(admin).address();
    let token = TokenClient::new(env, &token_id);
    let asset = StellarAssetClient::new(env, &token_id);
    let payer = Address::generate(env);
    let payee = Address::generate(env);
    let releaser = Address::generate(env);
    let arbiter = Address::generate(env);
    asset.mint(&payer, &1_000);
    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(env, &contract_id);
    let escrow_id = if with_arbiter {
        client.create_escrow_with_arbiter(
            &payer,
            &payee,
            &token_id,
            &300,
            &String::from_str(env, "dispute-ref"),
            &releaser,
            &None,
            &arbiter,
        )
    } else {
        client.create_escrow(
            &payer,
            &payee,
            &token_id,
            &300,
            &String::from_str(env, "legacy-ref"),
            &releaser,
            &None,
        )
    };
    Fixture {
        client,
        token,
        payer,
        payee,
        releaser,
        arbiter,
        escrow_id,
    }
}

#[test]
fn payer_or_payee_can_raise_dispute_and_freeze_release_and_refund() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env, true);

    f.client.raise_dispute(&f.escrow_id, &f.payee);
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Disputed);
    assert!(f.client.try_release(&f.escrow_id, &f.releaser).is_err());
    assert!(f.client.try_refund(&f.escrow_id, &f.releaser).is_err());
    assert_eq!(f.token.balance(&f.payee), 0);
    assert_eq!(f.token.balance(&f.payer), 700);
}

#[test]
fn only_payer_or_payee_can_raise_dispute() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env, true);
    assert!(f
        .client
        .try_raise_dispute(&f.escrow_id, &f.releaser)
        .is_err());
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Funded);
}

#[test]
fn legacy_creation_has_no_dispute_path() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env, false);
    assert!(f.client.try_raise_dispute(&f.escrow_id, &f.payer).is_err());
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Funded);
    f.client.release(&f.escrow_id, &f.releaser);
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Released);
}

#[test]
fn only_named_arbiter_can_resolve_and_resolution_releases_funds() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env, true);
    f.client.raise_dispute(&f.escrow_id, &f.payer);

    assert!(f
        .client
        .try_resolve_dispute(&f.escrow_id, &f.releaser, &DisputeOutcome::Release,)
        .is_err());
    f.client
        .resolve_dispute(&f.escrow_id, &f.arbiter, &DisputeOutcome::Release);
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Released);
    assert_eq!(f.token.balance(&f.payee), 300);
    assert!(f
        .client
        .try_resolve_dispute(&f.escrow_id, &f.arbiter, &DisputeOutcome::Refund,)
        .is_err());
}

#[test]
fn arbiter_can_resolve_dispute_by_refunding_payer() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env, true);
    f.client.raise_dispute(&f.escrow_id, &f.payer);
    f.client
        .resolve_dispute(&f.escrow_id, &f.arbiter, &DisputeOutcome::Refund);
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Refunded);
    assert_eq!(f.token.balance(&f.payer), 1_000);
}

#[test]
fn arbiter_must_be_distinct_from_payer_and_payee() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(admin).address();
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    let asset = StellarAssetClient::new(&env, &token_id);
    asset.mint(&payer, &1_000);
    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);

    assert!(client
        .try_create_escrow_with_arbiter(
            &payer,
            &payee,
            &token_id,
            &300,
            &String::from_str(&env, "payer-arbiter"),
            &releaser,
            &None,
            &payer,
        )
        .is_err());
    assert!(client
        .try_create_escrow_with_arbiter(
            &payer,
            &payee,
            &token_id,
            &300,
            &String::from_str(&env, "payee-arbiter"),
            &releaser,
            &None,
            &payee,
        )
        .is_err());
}

#[test]
fn whichever_lands_first_between_release_and_dispute_wins() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup(&env, true);
    f.client.release(&f.escrow_id, &f.releaser);
    assert!(f.client.try_raise_dispute(&f.escrow_id, &f.payee).is_err());
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Released);

    let second = setup(&env, true);
    second
        .client
        .raise_dispute(&second.escrow_id, &second.payee);
    assert!(second
        .client
        .try_release(&second.escrow_id, &second.releaser)
        .is_err());
    assert_eq!(
        second.client.get_status(&second.escrow_id),
        EscrowStatus::Disputed
    );
}
