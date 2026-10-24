//! Issue #48 / docs/adr/0012: a settled escrow's full record is reclaimed and
//! replaced by a one-field tombstone; the settlement event is the history.

use docforum_escrow::{
    Error, EscrowContract, EscrowContractClient, EscrowStatus, SettledEscrow,
};
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    vec,
    xdr::ToXdr,
    Address, Env, String, Vec,
};

struct Fixture<'a> {
    client: EscrowContractClient<'a>,
    token: TokenClient<'a>,
    token_id: Address,
    contract_id: Address,
    payer: Address,
    payee: Address,
    releaser: Address,
}

fn setup(env: &Env) -> Fixture<'_> {
    env.mock_all_auths();
    let sac = env.register_stellar_asset_contract_v2(Address::generate(env));
    let token_id = sac.address();
    let payer = Address::generate(env);
    StellarAssetClient::new(env, &token_id).mint(&payer, &10_000);
    let contract_id = env.register(EscrowContract, (Vec::<Address>::new(env),));
    Fixture {
        client: EscrowContractClient::new(env, &contract_id),
        token: TokenClient::new(env, &token_id),
        token_id,
        contract_id,
        payer,
        payee: Address::generate(env),
        releaser: Address::generate(env),
    }
}

fn create(env: &Env, f: &Fixture, reference: &str) -> u64 {
    f.client.create_escrow(
        &f.payer,
        &f.payee,
        &f.token_id,
        &250,
        &String::from_str(env, reference),
        &f.releaser,
        &None,
        &false,
        &None,
    )
}

#[test]
fn released_escrow_keeps_answering_get_status_from_the_tombstone() {
    let env = Env::default();
    let f = setup(&env);
    let id = create(&env, &f, "order-1");

    f.client.release(&id, &f.releaser);

    assert_eq!(f.client.get_status(&id), EscrowStatus::Released);
    assert_eq!(f.token.balance(&f.payee), 250);
}

#[test]
fn refunded_escrow_keeps_answering_get_status_from_the_tombstone() {
    let env = Env::default();
    let f = setup(&env);
    let id = create(&env, &f, "order-2");

    f.client.refund(&id, &f.releaser);

    assert_eq!(f.client.get_status(&id), EscrowStatus::Refunded);
    assert_eq!(f.token.balance(&f.payer), 10_000);
}

#[test]
fn cancelled_escrow_is_tombstoned_too() {
    let env = Env::default();
    let f = setup(&env);
    let id = f.client.create_escrow_with_acceptance(
        &f.payer,
        &f.payee,
        &f.token_id,
        &250,
        &String::from_str(&env, "needs-acceptance"),
        &f.releaser,
        &None,
        &true,
        &None,
    );

    f.client.cancel(&id, &f.payer);

    assert_eq!(f.client.get_status(&id), EscrowStatus::Cancelled);
    assert!(matches!(
        f.client.try_get_escrow(&id),
        Err(Ok(Error::NotFound))
    ));
}

#[test]
fn quorum_settlement_is_tombstoned_too() {
    let env = Env::default();
    let f = setup(&env);
    let (a, b, c) = (
        Address::generate(&env),
        Address::generate(&env),
        Address::generate(&env),
    );
    let id = f.client.create_escrow_with_releasers(
        &f.payer,
        &f.payee,
        &f.token_id,
        &250,
        &String::from_str(&env, "quorum"),
        &vec![&env, a.clone(), b.clone(), c],
        &2,
        &None,
        &false,
        &None,
    );

    f.client.release_with_approvals(&id, &vec![&env, a, b]);

    assert_eq!(f.client.get_status(&id), EscrowStatus::Released);
    assert!(matches!(
        f.client.try_get_escrow(&id),
        Err(Ok(Error::NotFound))
    ));
}

#[test]
fn get_escrow_reports_not_found_once_the_record_is_reclaimed() {
    let env = Env::default();
    let f = setup(&env);
    let released = create(&env, &f, "a");
    let refunded = create(&env, &f, "b");

    f.client.release(&released, &f.releaser);
    f.client.refund(&refunded, &f.releaser);

    assert!(matches!(
        f.client.try_get_escrow(&released),
        Err(Ok(Error::NotFound))
    ));
    assert!(matches!(
        f.client.try_get_escrow(&refunded),
        Err(Ok(Error::NotFound))
    ));
}

#[test]
fn never_created_ids_are_not_found_for_both_reads() {
    let env = Env::default();
    let f = setup(&env);

    assert_eq!(f.client.try_get_status(&999), Err(Ok(Error::NotFound)));
    assert!(matches!(
        f.client.try_get_escrow(&999),
        Err(Ok(Error::NotFound))
    ));
}

#[test]
fn funded_escrow_reads_are_unchanged() {
    let env = Env::default();
    let f = setup(&env);
    let id = create(&env, &f, "funded");

    assert_eq!(f.client.get_status(&id), EscrowStatus::Funded);
    let data = f.client.get_escrow(&id);
    assert_eq!(data.amount, 250);
    assert_eq!(data.status, EscrowStatus::Funded);
}

#[test]
fn settled_ids_are_never_reused() {
    let env = Env::default();
    let f = setup(&env);
    let first = create(&env, &f, "one");
    f.client.release(&first, &f.releaser);

    let second = create(&env, &f, "two");

    assert_eq!(second, first + 1);
    assert_eq!(f.client.get_status(&first), EscrowStatus::Released);
    assert_eq!(f.client.get_status(&second), EscrowStatus::Funded);
}

#[test]
fn mutating_a_settled_escrow_still_fails_not_funded() {
    let env = Env::default();
    let f = setup(&env);
    let id = create(&env, &f, "done");
    f.client.release(&id, &f.releaser);

    assert_eq!(
        f.client.try_release(&id, &f.releaser),
        Err(Ok(Error::NotFunded))
    );
    assert_eq!(
        f.client.try_refund(&id, &f.releaser),
        Err(Ok(Error::NotFunded))
    );
    assert_eq!(
        f.client.try_top_up(&id, &f.payer, &10),
        Err(Ok(Error::NotFunded))
    );
    // Funds moved exactly once.
    assert_eq!(f.token.balance(&f.payee), 250);
    assert_eq!(f.token.balance(&f.contract_id), 0);
}

#[test]
fn tombstone_is_much_smaller_than_the_full_record() {
    let env = Env::default();
    let f = setup(&env);
    let id = create(&env, &f, "order-with-a-typical-length-ref");

    let funded = f.client.get_escrow(&id).to_xdr(&env).len();
    let settled = SettledEscrow {
        status: EscrowStatus::Released,
    }
    .to_xdr(&env)
    .len();

    // Persistent-entry rent scales with entry size; run with `--nocapture` to
    // see the measured before/after (issue #48: "measure rent saved").
    println!("settled-escrow entry: {funded} bytes (full record) -> {settled} bytes (tombstone)");
    assert!(
        settled * 5 < funded,
        "tombstone ({settled} bytes) should be a fraction of the funded record ({funded} bytes)"
    );
}

#[test]
fn pooled_escrows_keep_their_full_record_after_release() {
    let env = Env::default();
    let f = setup(&env);
    env.ledger().set_timestamp(1_000);
    let creator = Address::generate(&env);
    let id = f.client.create_pooled_escrow(
        &creator,
        &f.payee,
        &f.token_id,
        &100,
        &String::from_str(&env, "pool"),
        &f.releaser,
        &1_100,
    );
    let contributor = Address::generate(&env);
    StellarAssetClient::new(&env, &f.token_id).mint(&contributor, &100);
    f.client.contribute(&id, &contributor, &100);

    f.client.release(&id, &f.releaser);

    // Pooled escrows are out of scope for reclamation (docs/adr/0012): their
    // contribution records and pull-based refunds read the record afterwards.
    assert_eq!(f.client.get_status(&id), EscrowStatus::Released);
    assert_eq!(f.client.get_escrow(&id).status, EscrowStatus::Released);
    assert_eq!(f.token.balance(&f.payee), 100);
    assert!(f.client.get_contribution(&id, &contributor).is_some());
}
