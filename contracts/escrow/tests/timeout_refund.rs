// Phase E4 tests — the optional `refund_after` timeout refund path
// (issue #11, docs/adr/0004). Per AGENTS.md hard rule 2: payment logic
// changes need tests here before merge, not a follow-up.
//
// Edge cases covered, as listed in issue #11:
//   - release in the same ledger the timeout passes
//   - `refund_after` already in the past at creation
//   - escrow already released/refunded before the timeout
//   - no `refund_after` set: behaviour identical to today
// plus the boundary itself (exactly at the deadline) and the read path
// payees need in order to check the deadline (threat model T8).

use docforum_escrow::{EscrowContract, EscrowContractClient, EscrowStatus};
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    Address, Env, String,
};

/// Ledger close time at escrow creation.
const CREATED_AT: u64 = 1_000;
/// The escrow's timeout deadline — always strictly after CREATED_AT.
const DEADLINE: u64 = 1_100;

fn setup<'a>(env: &Env) -> (Address, TokenClient<'a>, StellarAssetClient<'a>) {
    let admin = Address::generate(env);
    let contract_id = env.register_stellar_asset_contract_v2(admin);
    let token = TokenClient::new(env, &contract_id.address());
    let asset = StellarAssetClient::new(env, &contract_id.address());
    (contract_id.address(), token, asset)
}

struct Fixture<'a> {
    client: EscrowContractClient<'a>,
    token: TokenClient<'a>,
    contract_id: Address,
    payer: Address,
    payee: Address,
    releaser: Address,
    escrow_id: u64,
}

fn fund_escrow(env: &Env, refund_after: Option<u64>) -> Fixture<'_> {
    env.ledger().set_timestamp(CREATED_AT);

    let (token_id, token, asset) = setup(env);
    let payer = Address::generate(env);
    let payee = Address::generate(env);
    let releaser = Address::generate(env);
    asset.mint(&payer, &1_000);

    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(env, &contract_id);

    let escrow_id = client.create_escrow(
        &payer,
        &payee,
        &token_id,
        &300,
        &String::from_str(env, "opaque-condition-ref"),
        &releaser,
        &refund_after,
    );

    Fixture { client, token, contract_id, payer, payee, releaser, escrow_id }
}

// --- no refund_after: behaviour identical to before the timeout existed ---

#[test]
fn without_deadline_stranger_refund_stays_unauthorized_even_forever_after() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund_escrow(&env, None);
    let stranger = Address::generate(&env);

    // Any timestamp a deadline could have had has long passed: with no
    // `refund_after` stored, no timeout exists at all.
    env.ledger().set_timestamp(DEADLINE + 100_000);
    let result = f.client.try_refund(&f.escrow_id, &stranger);

    assert!(result.is_err());
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Funded);
    assert_eq!(f.token.balance(&f.payer), 700);
    assert_eq!(f.token.balance(&f.contract_id), 300);
}

#[test]
fn without_deadline_releaser_refund_still_works() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund_escrow(&env, None);

    f.client.refund(&f.escrow_id, &f.releaser);

    assert_eq!(f.token.balance(&f.payer), 1_000);
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Refunded);
}

// --- refund_after already in the past at creation ---

#[test]
fn create_escrow_rejects_deadline_already_passed_or_now() {
    let env = Env::default();
    env.mock_all_auths();
    let (token_id, token, asset) = setup(&env);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    asset.mint(&payer, &1_000);
    env.ledger().set_timestamp(CREATED_AT);

    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);

    let now = client.try_create_escrow(
        &payer, &payee, &token_id, &300,
        &String::from_str(&env, "ref-now"), &releaser, &Some(CREATED_AT),
    );
    let past = client.try_create_escrow(
        &payer, &payee, &token_id, &300,
        &String::from_str(&env, "ref-past"), &releaser, &Some(CREATED_AT - 1),
    );

    assert!(now.is_err());
    assert!(past.is_err());
    // Rejected creations locked nothing: the payer's funds are untouched
    // and no escrow exists to be refunded by anyone.
    assert_eq!(token.balance(&payer), 1_000);
    assert_eq!(token.balance(&contract_id), 0);
    assert!(client.try_get_status(&0).is_err());
}

#[test]
fn create_escrow_accepts_deadline_strictly_in_the_future() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund_escrow(&env, Some(DEADLINE));
    let data = f.client.get_escrow(&f.escrow_id);

    assert_eq!(data.refund_after, Some(DEADLINE));
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Funded);
}

// --- before the deadline: unchanged (releaser only) ---

#[test]
fn timeout_refund_rejected_before_deadline() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund_escrow(&env, Some(DEADLINE));
    let stranger = Address::generate(&env);

    env.ledger().set_timestamp(DEADLINE - 1);
    let result = f.client.try_refund(&f.escrow_id, &stranger);

    assert!(result.is_err());
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Funded);
    assert_eq!(f.token.balance(&f.payer), 700);
    assert_eq!(f.token.balance(&f.contract_id), 300);
}

#[test]
fn releaser_refund_still_works_before_deadline() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund_escrow(&env, Some(DEADLINE));

    env.ledger().set_timestamp(DEADLINE - 1);
    f.client.refund(&f.escrow_id, &f.releaser);

    assert_eq!(f.token.balance(&f.payer), 1_000);
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Refunded);
}

// --- at and after the deadline: anyone may refund, but only to payer ---

#[test]
fn timeout_refund_by_stranger_succeeds_at_the_exact_deadline() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund_escrow(&env, Some(DEADLINE));
    let stranger = Address::generate(&env);

    env.ledger().set_timestamp(DEADLINE);
    f.client.refund(&f.escrow_id, &stranger);

    assert_eq!(f.token.balance(&f.payer), 1_000); // back to payer, never anyone else
    assert_eq!(f.token.balance(&stranger), 0);
    assert_eq!(f.token.balance(&f.payee), 0);
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Refunded);
}

#[test]
fn timeout_refund_by_stranger_succeeds_after_deadline() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund_escrow(&env, Some(DEADLINE));
    let stranger = Address::generate(&env);

    env.ledger().set_timestamp(DEADLINE + 10_000);
    f.client.refund(&f.escrow_id, &stranger);

    assert_eq!(f.token.balance(&f.payer), 1_000);
    assert_eq!(f.token.balance(&f.contract_id), 0);
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Refunded);
}

#[test]
fn timeout_refund_cannot_pay_anyone_but_the_payer() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund_escrow(&env, Some(DEADLINE));
    let attacker = Address::generate(&env);

    env.ledger().set_timestamp(DEADLINE + 1);
    f.client.refund(&f.escrow_id, &attacker);

    assert_eq!(f.token.balance(&attacker), 0);
    assert_eq!(f.token.balance(&f.payee), 0);
    assert_eq!(f.token.balance(&f.payer), 1_000);
}

// --- release in the same ledger the timeout passes ---

#[test]
fn release_wins_at_the_deadline_and_timeout_refund_then_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund_escrow(&env, Some(DEADLINE));
    let stranger = Address::generate(&env);

    // The ledger whose close time is the deadline: release lands first.
    env.ledger().set_timestamp(DEADLINE);
    f.client.release(&f.escrow_id, &f.releaser);

    // Same ledger, later transaction: the timeout path finds it already
    // settled and cannot pay out twice (invariant I3).
    let timeout_attempt = f.client.try_refund(&f.escrow_id, &stranger);

    assert!(timeout_attempt.is_err());
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Released);
    assert_eq!(f.token.balance(&f.payee), 300);
    assert_eq!(f.token.balance(&f.payer), 700);
}

#[test]
fn timeout_refund_wins_at_the_deadline_and_release_then_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund_escrow(&env, Some(DEADLINE));
    let stranger = Address::generate(&env);

    // The other order in the same ledger: the timeout lands first, and
    // the releaser's own release can no longer pre-empt it.
    env.ledger().set_timestamp(DEADLINE);
    f.client.refund(&f.escrow_id, &stranger);
    let release_attempt = f.client.try_release(&f.escrow_id, &f.releaser);

    assert!(release_attempt.is_err());
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Refunded);
    assert_eq!(f.token.balance(&f.payee), 0);
    assert_eq!(f.token.balance(&f.payer), 1_000);
}

#[test]
fn releaser_can_still_release_after_the_deadline() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund_escrow(&env, Some(DEADLINE));

    // The timeout opens an extra refund path; it never takes the
    // releaser's own right to release away (docs/adr/0004).
    env.ledger().set_timestamp(DEADLINE + 1);
    f.client.release(&f.escrow_id, &f.releaser);

    assert_eq!(f.token.balance(&f.payee), 300);
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Released);
}

// --- escrow already released/refunded before the timeout ---

#[test]
fn timeout_refund_fails_after_release() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund_escrow(&env, Some(DEADLINE));
    let stranger = Address::generate(&env);

    env.ledger().set_timestamp(DEADLINE - 1);
    f.client.release(&f.escrow_id, &f.releaser);

    env.ledger().set_timestamp(DEADLINE + 1);
    let result = f.client.try_refund(&f.escrow_id, &stranger);

    assert!(result.is_err());
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Released);
    assert_eq!(f.token.balance(&f.payer), 700); // never got the 300 back
    assert_eq!(f.token.balance(&f.payee), 300);
}

#[test]
fn timeout_refund_fails_after_releaser_refund() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund_escrow(&env, Some(DEADLINE));
    let stranger = Address::generate(&env);

    env.ledger().set_timestamp(DEADLINE - 1);
    f.client.refund(&f.escrow_id, &f.releaser);

    env.ledger().set_timestamp(DEADLINE + 1);
    let result = f.client.try_refund(&f.escrow_id, &stranger);

    assert!(result.is_err());
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Refunded);
    assert_eq!(f.token.balance(&f.payer), 1_000); // returned once, not twice
    assert_eq!(f.token.balance(&f.contract_id), 0);
}

// --- read path: get_escrow (threat model T8 — payees checking the deal) ---

#[test]
fn get_escrow_exposes_the_stored_parties_and_deadline() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund_escrow(&env, Some(DEADLINE));

    let data = f.client.get_escrow(&f.escrow_id);

    assert_eq!(data.payer, f.payer);
    assert_eq!(data.payee, f.payee);
    assert_eq!(data.amount, 300);
    assert_eq!(data.releaser, f.releaser);
    assert_eq!(data.refund_after, Some(DEADLINE));
    assert_eq!(data.status, EscrowStatus::Funded);
}

#[test]
fn get_escrow_reports_no_deadline_when_none_was_set() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund_escrow(&env, None);

    let data = f.client.get_escrow(&f.escrow_id);

    assert_eq!(data.refund_after, None);
    assert_eq!(data.status, EscrowStatus::Funded);
}

#[test]
fn get_escrow_errors_for_unknown_escrow() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);

    let result = client.try_get_escrow(&999);
    assert!(result.is_err());
}
