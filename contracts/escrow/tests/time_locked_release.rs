// Phase E5 tests — optional `release_not_before` guard (issue #43).
// The lock opens at the exact configured ledger timestamp. Refund
// authorization and behavior remain independent from the release lock.

use docforum_escrow::{Error, EscrowContract, EscrowContractClient, EscrowStatus};
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    Address, Env, String,
};

const CREATED_AT: u64 = 1_000;
const RELEASE_AT: u64 = 1_100;
const REFUND_AT: u64 = 1_200;

struct Fixture<'a> {
    client: EscrowContractClient<'a>,
    token: TokenClient<'a>,
    contract_id: Address,
    payer: Address,
    payee: Address,
    releaser: Address,
    escrow_id: u64,
}

fn setup<'a>(env: &Env, release_at: Option<u64>, refund_at: Option<u64>) -> Fixture<'_> {
    env.ledger().set_timestamp(CREATED_AT);
    env.mock_all_auths();

    let admin = Address::generate(env);
    let token_id = env.register_stellar_asset_contract_v2(admin).address();
    let token = TokenClient::new(env, &token_id);
    let asset = StellarAssetClient::new(env, &token_id);
    let payer = Address::generate(env);
    let payee = Address::generate(env);
    let releaser = Address::generate(env);
    asset.mint(&payer, &1_000);

    let contract_id = env.register(EscrowContract, (soroban_sdk::Vec::<Address>::new(env),));
    let client = EscrowContractClient::new(env, &contract_id);
    let escrow_id = client.create_escrow_release_time(
        &payer,
        &payee,
        &token_id,
        &300,
        &String::from_str(env, "opaque-condition-ref"),
        &releaser,
        &refund_at,
        &false,
        &None,
        &release_at,
    );

    Fixture {
        client,
        token,
        contract_id,
        payer,
        payee,
        releaser,
        escrow_id,
    }
}

#[test]
fn release_is_rejected_before_time_and_allowed_at_the_exact_boundary() {
    let env = Env::default();
    let f = setup(&env, Some(RELEASE_AT), Some(REFUND_AT));
    let data = f.client.get_escrow(&f.escrow_id);
    assert_eq!(data.release_not_before, Some(RELEASE_AT));

    env.ledger().set_timestamp(RELEASE_AT - 1);
    let early = f.client.try_release(&f.escrow_id, &f.releaser);
    assert_eq!(early, Err(Ok(Error::ReleaseTooEarly)));
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Funded);
    assert_eq!(f.token.balance(&f.contract_id), 300);
    assert_eq!(f.token.balance(&f.payee), 0);

    env.ledger().set_timestamp(RELEASE_AT);
    f.client.release(&f.escrow_id, &f.releaser);
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Released);
    assert_eq!(f.token.balance(&f.payee), 300);
}

#[test]
fn release_lock_does_not_restrict_releaser_refunds() {
    let env = Env::default();
    let f = setup(&env, Some(RELEASE_AT), Some(REFUND_AT));

    f.client.refund(&f.escrow_id, &f.releaser);

    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Refunded);
    assert_eq!(f.token.balance(&f.payer), 1_000);
    assert_eq!(f.token.balance(&f.contract_id), 0);
}

#[test]
fn creation_rejects_release_time_in_the_past_or_after_refund_deadline() {
    let env = Env::default();
    env.ledger().set_timestamp(CREATED_AT);
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(admin).address();
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    let asset = StellarAssetClient::new(&env, &token_id);
    asset.mint(&payer, &1_000);
    let contract_id = env.register(EscrowContract, (soroban_sdk::Vec::<Address>::new(&env),));
    let client = EscrowContractClient::new(&env, &contract_id);

    let past = client.try_create_escrow_release_time(
        &payer,
        &payee,
        &token_id,
        &300,
        &String::from_str(&env, "past-release"),
        &releaser,
        &Some(REFUND_AT),
        &false,
        &None,
        &Some(CREATED_AT - 1),
    );
    let after_refund = client.try_create_escrow_release_time(
        &payer,
        &payee,
        &token_id,
        &300,
        &String::from_str(&env, "late-release"),
        &releaser,
        &Some(REFUND_AT),
        &false,
        &None,
        &Some(REFUND_AT + 1),
    );

    assert_eq!(past, Err(Ok(Error::InvalidReleaseNotBefore)));
    assert_eq!(after_refund, Err(Ok(Error::InvalidReleaseNotBefore)));
    assert_eq!(asset.balance(&payer), 1_000);
    assert!(client.try_get_status(&0).is_err());
}

#[test]
fn release_time_equal_to_refund_deadline_is_valid() {
    let env = Env::default();
    let f = setup(&env, Some(REFUND_AT), Some(REFUND_AT));
    assert_eq!(
        f.client.get_escrow(&f.escrow_id).release_not_before,
        Some(REFUND_AT)
    );
}
