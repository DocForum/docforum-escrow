// Tests for issue #41: extend an escrow's refund deadline only with
// payer and releaser authorization while the original deadline is active.

use docforum_escrow::{EscrowContract, EscrowContractClient, EscrowStatus};
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token::StellarAssetClient,
    Address, Env, String, Vec,
};

const CREATED_AT: u64 = 1_000;
const DEADLINE: u64 = 1_100;

struct Fixture<'a> {
    client: EscrowContractClient<'a>,
    escrow_id: u64,
}

fn fund_escrow(env: &Env, refund_after: Option<u64>) -> Fixture<'_> {
    env.ledger().set_timestamp(CREATED_AT);
    let admin = Address::generate(env);
    let token_id = env.register_stellar_asset_contract_v2(admin).address();
    let asset = StellarAssetClient::new(env, &token_id);
    let payer = Address::generate(env);
    let payee = Address::generate(env);
    let releaser = Address::generate(env);
    asset.mint(&payer, &1_000);

    let contract_id = env.register(EscrowContract, (Vec::<Address>::new(env),));
    let client = EscrowContractClient::new(env, &contract_id);
    let escrow_id = client.create_escrow(
        &payer,
        &payee,
        &token_id,
        &300,
        &String::from_str(env, "issue-41"),
        &releaser,
        &refund_after,
        &false,
    );

    Fixture { client, escrow_id }
}

#[test]
fn payer_and_releaser_can_extend_deadline_and_get_escrow_returns_latest_value() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund_escrow(&env, Some(DEADLINE));

    f.client
        .extend_refund_after(&f.escrow_id, &(DEADLINE + 100));

    let updated = f.client.get_escrow(&f.escrow_id);
    assert_eq!(updated.status, EscrowStatus::Funded);
    assert_eq!(updated.refund_after, Some(DEADLINE + 100));
}

#[test]
fn extension_fails_when_auth_is_missing() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund_escrow(&env, Some(DEADLINE));

    // Replace the all-auth mock with an empty authorization set.
    env.mock_auths(&[]);
    let result = f
        .client
        .try_extend_refund_after(&f.escrow_id, &(DEADLINE + 100));

    assert!(result.is_err());
    assert_eq!(
        f.client.get_escrow(&f.escrow_id).refund_after,
        Some(DEADLINE)
    );
}

#[test]
fn extension_rejects_an_earlier_or_equal_deadline() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund_escrow(&env, Some(DEADLINE));

    assert!(f
        .client
        .try_extend_refund_after(&f.escrow_id, &DEADLINE)
        .is_err());
    assert!(f
        .client
        .try_extend_refund_after(&f.escrow_id, &(DEADLINE - 1))
        .is_err());
    assert_eq!(
        f.client.get_escrow(&f.escrow_id).refund_after,
        Some(DEADLINE)
    );
}

#[test]
fn extension_rejects_after_the_existing_deadline_passes() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund_escrow(&env, Some(DEADLINE));
    env.ledger().set_timestamp(DEADLINE);

    let result = f
        .client
        .try_extend_refund_after(&f.escrow_id, &(DEADLINE + 100));

    assert!(result.is_err());
    assert_eq!(
        f.client.get_escrow(&f.escrow_id).refund_after,
        Some(DEADLINE)
    );
}

#[test]
fn extension_requires_an_existing_deadline() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund_escrow(&env, None);

    assert!(f
        .client
        .try_extend_refund_after(&f.escrow_id, &(DEADLINE + 100))
        .is_err());
    assert_eq!(f.client.get_escrow(&f.escrow_id).refund_after, None);
}
