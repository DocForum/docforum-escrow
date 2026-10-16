// Phase E5 tests — payer `cancel` before payee `accept` (issue #27,
// docs/adr/0005). Per AGENTS.md hard rule 2: payment logic changes need
// tests here before merge.
//
// Covered:
//   - cancel happy path (funds to payer, I1: nothing to anyone else)
//   - the accept/cancel race, BOTH orderings, inside one ledger
//   - auth: only the stored payer cancels, only the stored payee accepts
//   - escrows without `requires_acceptance` are unaffected
//   - cancel never reachable after a payout (release / refund / cancel)
//   - cancel interacts correctly with `refund_after` and the releaser

use docforum_escrow::{Error, EscrowContract, EscrowContractClient, EscrowStatus};
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    Address, Env, String,
};

const CREATED_AT: u64 = 1_000;
const DEADLINE: u64 = 1_100;

struct Fixture<'a> {
    client: EscrowContractClient<'a>,
    token: TokenClient<'a>,
    contract_id: Address,
    payer: Address,
    payee: Address,
    releaser: Address,
    escrow_id: u64,
}

fn fund<'a>(env: &'a Env, requires_acceptance: bool, refund_after: Option<u64>) -> Fixture<'a> {
    env.ledger().set_timestamp(CREATED_AT);

    let admin = Address::generate(env);
    let sac = env.register_stellar_asset_contract_v2(admin);
    let token = TokenClient::new(env, &sac.address());
    let asset = StellarAssetClient::new(env, &sac.address());
    let payer = Address::generate(env);
    let payee = Address::generate(env);
    let releaser = Address::generate(env);
    asset.mint(&payer, &1_000);

    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(env, &contract_id);
    let escrow_id = client.create_escrow(
        &payer,
        &payee,
        &sac.address(),
        &300,
        &String::from_str(env, "opaque-condition-ref"),
        &releaser,
        &refund_after,
        &requires_acceptance,
    );

    Fixture { client, token, contract_id, payer, payee, releaser, escrow_id }
}

fn assert_unchanged_funded(f: &Fixture) {
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Funded);
    assert_eq!(f.token.balance(&f.payer), 700);
    assert_eq!(f.token.balance(&f.payee), 0);
    assert_eq!(f.token.balance(&f.contract_id), 300);
}

// --- happy path -----------------------------------------------------------

#[test]
fn payer_cancel_before_accept_refunds_payer_in_full() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund(&env, true, None);

    f.client.cancel(&f.escrow_id, &f.payer);

    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Cancelled);
    assert_eq!(f.token.balance(&f.payer), 1_000);
    assert_eq!(f.token.balance(&f.payee), 0);
    assert_eq!(f.token.balance(&f.contract_id), 0);
}

#[test]
fn new_escrow_records_acceptance_flags() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund(&env, true, None);

    let data = f.client.get_escrow(&f.escrow_id);
    assert!(data.requires_acceptance);
    assert!(!data.accepted);

    f.client.accept(&f.escrow_id, &f.payee);
    let data = f.client.get_escrow(&f.escrow_id);
    assert!(data.requires_acceptance);
    assert!(data.accepted);
}

// --- the race: accept vs cancel in the SAME ledger -------------------------

#[test]
fn race_accept_lands_first_then_cancel_fails_and_payee_keeps_the_escrow() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund(&env, true, None);

    // Same ledger: timestamp and sequence are untouched between the calls.
    let ledger_before = env.ledger().sequence();
    f.client.accept(&f.escrow_id, &f.payee);
    let cancel = f.client.try_cancel(&f.escrow_id, &f.payer);
    assert_eq!(env.ledger().sequence(), ledger_before);

    assert_eq!(cancel, Err(Ok(Error::AlreadyAccepted)));
    assert_unchanged_funded(&f);
    assert!(f.client.get_escrow(&f.escrow_id).accepted);

    // The accepted escrow still settles normally via the releaser.
    f.client.release(&f.escrow_id, &f.releaser);
    assert_eq!(f.token.balance(&f.payee), 300);
    assert_eq!(f.token.balance(&f.payer), 700);
}

#[test]
fn race_cancel_lands_first_then_accept_fails_and_payer_keeps_the_funds() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund(&env, true, None);

    let ledger_before = env.ledger().sequence();
    f.client.cancel(&f.escrow_id, &f.payer);
    let accept = f.client.try_accept(&f.escrow_id, &f.payee);
    assert_eq!(env.ledger().sequence(), ledger_before);

    assert_eq!(accept, Err(Ok(Error::NotFunded)));
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Cancelled);
    assert!(!f.client.get_escrow(&f.escrow_id).accepted);
    assert_eq!(f.token.balance(&f.payer), 1_000);
    assert_eq!(f.token.balance(&f.payee), 0);
    assert_eq!(f.token.balance(&f.contract_id), 0);

    // And the cancelled escrow can't then be paid out either.
    assert_eq!(
        f.client.try_release(&f.escrow_id, &f.releaser),
        Err(Ok(Error::NotFunded))
    );
    assert_eq!(f.token.balance(&f.payee), 0);
}

// --- cancellation window closes for good -----------------------------------

#[test]
fn cancel_stays_rejected_after_accept_even_much_later() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund(&env, true, None);

    f.client.accept(&f.escrow_id, &f.payee);
    env.ledger().set_timestamp(CREATED_AT + 1_000_000);

    assert_eq!(
        f.client.try_cancel(&f.escrow_id, &f.payer),
        Err(Ok(Error::AlreadyAccepted))
    );
    assert_unchanged_funded(&f);
}

#[test]
fn double_accept_is_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund(&env, true, None);

    f.client.accept(&f.escrow_id, &f.payee);
    assert_eq!(
        f.client.try_accept(&f.escrow_id, &f.payee),
        Err(Ok(Error::AlreadyAccepted))
    );
}

#[test]
fn double_cancel_is_rejected_and_pays_out_once() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund(&env, true, None);

    f.client.cancel(&f.escrow_id, &f.payer);
    assert_eq!(
        f.client.try_cancel(&f.escrow_id, &f.payer),
        Err(Ok(Error::NotFunded))
    );
    assert_eq!(f.token.balance(&f.payer), 1_000);
}

// --- authorisation ----------------------------------------------------------

#[test]
fn only_the_stored_payer_may_cancel() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund(&env, true, None);

    for impostor in [
        Address::generate(&env),
        f.payee.clone(),
        f.releaser.clone(),
    ] {
        assert_eq!(
            f.client.try_cancel(&f.escrow_id, &impostor),
            Err(Ok(Error::Unauthorized))
        );
    }
    assert_unchanged_funded(&f);
}

#[test]
fn cancel_requires_the_payers_signature() {
    let env = Env::default();
    // Funding needs auth, so fund under the blanket mock, then drop every
    // mocked auth and check an unsigned cancel is refused.
    env.mock_all_auths();
    let f = fund(&env, true, None);

    env.mock_auths(&[]);
    let result = f.client.try_cancel(&f.escrow_id, &f.payer);

    assert!(result.is_err());
    assert_unchanged_funded(&f);
}

#[test]
fn only_the_stored_payee_may_accept() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund(&env, true, None);

    for impostor in [
        Address::generate(&env),
        f.payer.clone(),
        f.releaser.clone(),
    ] {
        assert_eq!(
            f.client.try_accept(&f.escrow_id, &impostor),
            Err(Ok(Error::Unauthorized))
        );
    }
    assert!(!f.client.get_escrow(&f.escrow_id).accepted);
    // A failed accept by an impostor does not close the window.
    f.client.cancel(&f.escrow_id, &f.payer);
    assert_eq!(f.token.balance(&f.payer), 1_000);
}

#[test]
fn cancel_and_accept_on_unknown_escrow_report_not_found() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund(&env, true, None);

    assert_eq!(f.client.try_cancel(&99, &f.payer), Err(Ok(Error::NotFound)));
    assert_eq!(f.client.try_accept(&99, &f.payee), Err(Ok(Error::NotFound)));
}

// --- escrows without requires_acceptance are unaffected ---------------------

#[test]
fn cancel_is_not_available_without_requires_acceptance() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund(&env, false, None);

    assert_eq!(
        f.client.try_cancel(&f.escrow_id, &f.payer),
        Err(Ok(Error::AcceptanceNotRequired))
    );
    assert_unchanged_funded(&f);
    let data = f.client.get_escrow(&f.escrow_id);
    assert!(!data.requires_acceptance);
    assert!(!data.accepted);
}

#[test]
fn accept_is_not_available_without_requires_acceptance() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund(&env, false, None);

    assert_eq!(
        f.client.try_accept(&f.escrow_id, &f.payee),
        Err(Ok(Error::AcceptanceNotRequired))
    );
    assert!(!f.client.get_escrow(&f.escrow_id).accepted);
}

#[test]
fn escrow_without_requires_acceptance_still_releases_and_refunds_as_before() {
    let env = Env::default();
    env.mock_all_auths();

    let released = fund(&env, false, None);
    released.client.release(&released.escrow_id, &released.releaser);
    assert_eq!(released.token.balance(&released.payee), 300);
    assert_eq!(
        released.client.get_status(&released.escrow_id),
        EscrowStatus::Released
    );

    let refunded = fund(&env, false, None);
    refunded.client.refund(&refunded.escrow_id, &refunded.releaser);
    assert_eq!(refunded.token.balance(&refunded.payer), 1_000);
    assert_eq!(
        refunded.client.get_status(&refunded.escrow_id),
        EscrowStatus::Refunded
    );
}

// --- cancel is never reachable after a payout --------------------------------

#[test]
fn cancel_after_release_is_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund(&env, true, None);

    // The releaser settles before the payee ever accepts.
    f.client.release(&f.escrow_id, &f.releaser);

    assert_eq!(
        f.client.try_cancel(&f.escrow_id, &f.payer),
        Err(Ok(Error::NotFunded))
    );
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Released);
    assert_eq!(f.token.balance(&f.payee), 300);
    assert_eq!(f.token.balance(&f.payer), 700);
}

#[test]
fn cancel_after_releaser_refund_is_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund(&env, true, None);

    f.client.refund(&f.escrow_id, &f.releaser);

    assert_eq!(
        f.client.try_cancel(&f.escrow_id, &f.payer),
        Err(Ok(Error::NotFunded))
    );
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Refunded);
    assert_eq!(f.token.balance(&f.payer), 1_000);
}

#[test]
fn releaser_cannot_pay_out_after_cancel() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund(&env, true, None);

    f.client.cancel(&f.escrow_id, &f.payer);

    assert_eq!(
        f.client.try_refund(&f.escrow_id, &f.releaser),
        Err(Ok(Error::NotFunded))
    );
    assert_eq!(f.token.balance(&f.payer), 1_000);
}

// --- interaction with the refund_after timeout -------------------------------

#[test]
fn cancel_still_works_after_refund_after_has_passed_if_still_funded() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund(&env, true, Some(DEADLINE));

    env.ledger().set_timestamp(DEADLINE + 1);
    f.client.cancel(&f.escrow_id, &f.payer);

    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Cancelled);
    assert_eq!(f.token.balance(&f.payer), 1_000);
}

#[test]
fn cancel_after_timeout_refund_is_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund(&env, true, Some(DEADLINE));

    env.ledger().set_timestamp(DEADLINE);
    f.client.refund(&f.escrow_id, &Address::generate(&env));

    assert_eq!(
        f.client.try_cancel(&f.escrow_id, &f.payer),
        Err(Ok(Error::NotFunded))
    );
    assert_eq!(f.token.balance(&f.payer), 1_000);
}

// --- cancelling one escrow never touches another ------------------------------

#[test]
fn cancel_only_returns_that_escrows_amount() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund(&env, true, None);

    // A second escrow in the same contract and token.
    let second = f.client.create_escrow(
        &f.payer,
        &f.payee,
        &f.token.address,
        &200,
        &String::from_str(&env, "second"),
        &f.releaser,
        &None,
        &true,
    );
    assert_eq!(f.token.balance(&f.contract_id), 500);

    f.client.cancel(&f.escrow_id, &f.payer);

    assert_eq!(f.token.balance(&f.contract_id), 200);
    assert_eq!(f.token.balance(&f.payer), 800);
    assert_eq!(f.client.get_status(&second), EscrowStatus::Funded);
}
