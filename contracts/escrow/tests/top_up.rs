use docforum_escrow::{Error, EscrowContract, EscrowContractClient, EscrowStatus};
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Events as _, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    vec, Address, Env, IntoVal, String, Vec,
};

struct Fixture<'a> {
    client: EscrowContractClient<'a>,
    token: TokenClient<'a>,
    payer: Address,
    payee: Address,
    releaser: Address,
    contract_id: Address,
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
    asset.mint(&payer, &1_000);
    let contract_id = env.register(
        EscrowContract,
        (Vec::<Address>::new(env), Address::generate(env)),
    );
    let client = EscrowContractClient::new(env, &contract_id);
    let id = client.create_escrow(
        &payer,
        &payee,
        &token_id,
        &300,
        &String::from_str(env, "top-up"),
        &releaser,
        &None,
        &false,
        &None,
        &None,
        &None,
    );
    Fixture {
        client,
        token,
        payer,
        payee,
        releaser,
        contract_id,
        id,
    }
}

#[test]
fn top_up_adds_funds_to_the_same_funded_escrow() {
    let env = Env::default();
    let f = setup(&env);
    f.client.top_up(&f.id, &f.payer, &200);
    let data = f.client.get_escrow(&f.id);
    assert_eq!(data.amount, 500);
    assert_eq!(data.status, EscrowStatus::Funded);
    assert_eq!(f.token.balance(&f.payer), 500);
    assert_eq!(f.token.balance(&f.contract_id), 500);
    f.client.release(&f.id, &f.releaser);
    assert_eq!(f.token.balance(&f.payee), 500);
}

/// `top_up` is the only lifecycle event this contract emits today (contract
/// lifecycle events are issue #9). Per issue #120 this test's committed
/// snapshot is the one that shows an event diff when the event changes —
/// note there is deliberately no contract call after `top_up`: the test SDK
/// clears the event buffer at the start of every top-level invocation, so a
/// trailing read/assert-call would empty the snapshot's `events` array.
#[test]
fn top_up_emits_an_event() {
    let env = Env::default();
    let f = setup(&env);

    f.client.top_up(&f.id, &f.payer, &200);

    // Only this contract's events: the token's own `transfer` event is
    // emitted by a different contract in the same invocation.
    assert_eq!(
        env.events().all().filter_by_contract(&f.contract_id),
        vec![
            &env,
            (
                f.contract_id.clone(),
                (symbol_short!("top_up"), f.id).into_val(&env),
                (200i128, 500i128).into_val(&env),
            ),
        ]
    );
}

#[test]
fn top_up_a_quorum_escrow_raises_what_the_threshold_releases() {
    // A quorum escrow grows exactly like a single-releaser one: the stored
    // payer tops it up, and the raised amount is what the approvers settle.
    let env = Env::default();
    let f = setup(&env);
    let co_releaser = Address::generate(&env);
    let releasers = vec![&env, f.releaser.clone(), co_releaser.clone()];
    let id = f.client.create_escrow_with_releasers(
        &f.payer,
        &f.payee,
        &f.token.address,
        &300,
        &String::from_str(&env, "top-up-quorum"),
        &releasers,
        &2,
        &None,
        &false,
        &None,
    );

    f.client.top_up(&id, &f.payer, &200);

    let data = f.client.get_escrow(&id);
    assert_eq!(data.amount, 500);
    assert_eq!(data.status, EscrowStatus::Funded);
    // The first fixture escrow (300) plus the topped-up quorum escrow (500).
    assert_eq!(f.client.solvency(&f.token.address), (800, 800));

    f.client
        .release_with_approvals(&id, &vec![&env, f.releaser.clone(), co_releaser]);

    assert_eq!(f.token.balance(&f.payee), 500);
    assert_eq!(f.client.solvency(&f.token.address), (300, 300));
}

#[test]
fn top_up_after_acceptance_grows_the_escrow_but_a_top_up_after_release_is_rejected_t13() {
    // Threat model T13: a `top_up` that lands after the release settled must
    // not grow a settled escrow. Acceptance is the point where a release is
    // one releaser call away, so it is the interesting moment to top up:
    // the top-up is accepted while the escrow is still `Funded`, and the
    // same top-up is rejected with `NotFunded` once the release landed.
    let env = Env::default();
    let f = setup(&env);
    let id = f.client.create_escrow_with_acceptance(
        &f.payer,
        &f.payee,
        &f.token.address,
        &300,
        &String::from_str(&env, "top-up-acceptance"),
        &f.releaser,
        &None,
        &true,
        &None,
    );

    f.client.accept(&id, &f.payee);
    f.client.top_up(&id, &f.payer, &200);
    assert_eq!(f.client.get_escrow(&id).amount, 500);

    f.client.release(&id, &f.releaser);
    assert_eq!(f.token.balance(&f.payee), 500);

    assert_eq!(
        f.client.try_top_up(&id, &f.payer, &100),
        Err(Ok(Error::NotFunded))
    );
    assert_eq!(f.token.balance(&f.contract_id), 300);
}

#[test]
fn top_up_a_release_not_before_escrow_keeps_the_time_lock() {
    // Topping up adds funds, not a new release path: the escrow's
    // `release_not_before` still gates the raised amount.
    let env = Env::default();
    let f = setup(&env);
    env.ledger().set_timestamp(1_000);
    let release_at = 2_000;
    let id = f.client.create_escrow_release_time(
        &f.payer,
        &f.payee,
        &f.token.address,
        &300,
        &String::from_str(&env, "top-up-timelock"),
        &f.releaser,
        &None,
        &false,
        &None,
        &Some(release_at),
        &None,
        &None,
    );

    f.client.top_up(&id, &f.payer, &200);
    assert_eq!(f.client.get_escrow(&id).amount, 500);
    assert_eq!(
        f.client.get_escrow(&id).release_not_before,
        Some(release_at)
    );

    env.ledger().set_timestamp(release_at - 1);
    assert_eq!(
        f.client.try_release(&id, &f.releaser),
        Err(Ok(Error::ReleaseTooEarly))
    );

    env.ledger().set_timestamp(release_at);
    f.client.release(&id, &f.releaser);
    assert_eq!(f.token.balance(&f.payee), 500);
}

#[test]
fn top_up_rejects_invalid_payer_amount_overflow_and_settled_state() {
    let env = Env::default();
    let f = setup(&env);
    let stranger = Address::generate(&env);
    assert!(f.client.try_top_up(&f.id, &stranger, &1).is_err());
    assert!(f.client.try_top_up(&f.id, &f.payer, &0).is_err());
    assert!(f.client.try_top_up(&f.id, &f.payer, &i128::MAX).is_err());
    f.client.release(&f.id, &f.releaser);
    assert!(f.client.try_top_up(&f.id, &f.payer, &1).is_err());
}
