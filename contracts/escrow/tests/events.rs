// Phase E4 — event emission tests (issue #9, threat-model T7).
//
// Definition of done (issue spec):
//  - Tests assert the exact events on each happy path.
//  - None are emitted on error paths (unauthorized, not funded,
//    invalid amount).
//
// Event shape (see ARCHITECTURE_ESSENTIALS.md § Events):
//  Topic:   ("ESCROW", action, escrow_id)
//           action ∈ { "created", "released", "refunded" }
//  Payload: (payer, destination, token, amount)
//           destination = payee on create/release,
//                         refund_to on refund.
//
// condition_ref is intentionally absent (threat model T9).
//
// Note on env.events().all(): the Soroban test SDK clears the event
// buffer at the start of every top-level contract invocation. So
// env.events().all() returns only the events emitted by the *last*
// contract call made in a test, not a cumulative log. Each test
// therefore ends on the call whose events it wants to assert.

use docforum_escrow::{EscrowContract, EscrowContractClient};
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Events as _, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    vec, Address, Env, IntoVal, String, Vec,
};

// ── helpers ──────────────────────────────────────────────────────────────────

fn setup_token(env: &Env) -> (Address, TokenClient<'_>, StellarAssetClient<'_>) {
    let admin = Address::generate(env);
    let id = env.register_stellar_asset_contract_v2(admin).address();
    let token = TokenClient::new(env, &id);
    let asset = StellarAssetClient::new(env, &id);
    (id, token, asset)
}

struct Fixture<'a> {
    client: EscrowContractClient<'a>,
    contract_id: Address,
    token_id: Address,
    payer: Address,
    payee: Address,
    releaser: Address,
    escrow_id: u64,
}

/// Creates a funded escrow and returns the fixture. The event buffer after
/// this call contains exactly the "created" event — no further calls are
/// made, so the buffer is not cleared.
fn funded_escrow(env: &Env, amount: i128) -> Fixture<'_> {
    let (token_id, _token, asset) = setup_token(env);
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
        &amount,
        &String::from_str(env, "opaque-ref"),
        &releaser,
        &None,
        &false,
        &None,
    );

    Fixture {
        client,
        contract_id,
        token_id,
        payer,
        payee,
        releaser,
        escrow_id,
    }
}

// ── create_escrow happy path ──────────────────────────────────────────────────

/// create_escrow must emit exactly one event with topic
/// ("ESCROW", "created", escrow_id) and payload (payer, payee, token, amount).
/// condition_ref must NOT appear in the payload.
#[test]
fn create_emits_one_event_with_correct_topic_and_payload() {
    let env = Env::default();
    env.mock_all_auths();
    // funded_escrow ends on create_escrow — env.events().all() shows its events.
    let f = funded_escrow(&env, 300);

    assert_eq!(
        env.events().all().filter_by_contract(&f.contract_id),
        vec![
            &env,
            (
                f.contract_id.clone(),
                (
                    symbol_short!("ESCROW"),
                    symbol_short!("created"),
                    f.escrow_id,
                )
                    .into_val(&env),
                (f.payer.clone(), f.payee.clone(), f.token_id.clone(), 300i128).into_val(&env),
            ),
        ]
    );
}

/// Error path: invalid amount emits no event.
#[test]
fn create_error_path_emits_no_event() {
    let env = Env::default();
    env.mock_all_auths();

    let (token_id, _token, asset) = setup_token(&env);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    asset.mint(&payer, &1_000);

    let contract_id = env.register(EscrowContract, (Vec::<Address>::new(&env),));
    let client = EscrowContractClient::new(&env, &contract_id);

    // Amount == 0 is rejected before any state change or event.
    let _ = client.try_create_escrow(
        &payer,
        &payee,
        &token_id,
        &0,
        &String::from_str(&env, "opaque-ref"),
        &releaser,
        &None,
        &false,
        &None,
    );

    // The failed try_create_escrow is the last call; its event buffer is empty.
    assert_eq!(
        env.events()
            .all()
            .filter_by_contract(&contract_id)
            .events()
            .len(),
        0,
        "error path must not emit any events"
    );
}

// ── release happy path ────────────────────────────────────────────────────────

/// release must emit exactly one event with topic
/// ("ESCROW", "released", escrow_id) and payload (payer, payee, token, amount).
#[test]
fn release_emits_event_with_correct_topic_and_payload() {
    let env = Env::default();
    env.mock_all_auths();
    let f = funded_escrow(&env, 300);

    // release is the last call — its events are what env.events().all() returns.
    f.client.release(&f.escrow_id, &f.releaser);

    // release emits exactly one "released" event (the create event was in the
    // prior invocation and is no longer in the buffer).
    assert_eq!(
        env.events().all().filter_by_contract(&f.contract_id),
        vec![
            &env,
            (
                f.contract_id.clone(),
                (
                    symbol_short!("ESCROW"),
                    symbol_short!("released"),
                    f.escrow_id,
                )
                    .into_val(&env),
                (f.payer.clone(), f.payee.clone(), f.token_id.clone(), 300i128).into_val(&env),
            ),
        ]
    );
}

/// Error path: release by an unauthorized caller emits no event.
#[test]
fn release_unauthorized_emits_no_event() {
    let env = Env::default();
    env.mock_all_auths();
    let f = funded_escrow(&env, 300);
    let stranger = Address::generate(&env);

    // The failed try_release is the last call; its events must be empty.
    let _ = f.client.try_release(&f.escrow_id, &stranger);

    assert_eq!(
        env.events()
            .all()
            .filter_by_contract(&f.contract_id)
            .events()
            .len(),
        0,
        "unauthorized release must not emit any events"
    );
}

/// Error path: release on an already-released (non-funded) escrow emits no event.
#[test]
fn release_on_settled_escrow_emits_no_event() {
    let env = Env::default();
    env.mock_all_auths();
    let f = funded_escrow(&env, 300);

    // First release succeeds and emits "released".
    f.client.release(&f.escrow_id, &f.releaser);

    // Second release on the already-Released escrow must fail without emitting.
    let _ = f.client.try_release(&f.escrow_id, &f.releaser);

    // The failed second try_release is the last call — its buffer must be empty.
    assert_eq!(
        env.events()
            .all()
            .filter_by_contract(&f.contract_id)
            .events()
            .len(),
        0,
        "a failed second release must not emit any event"
    );
}

// ── refund happy path ─────────────────────────────────────────────────────────

/// refund must emit exactly one event with topic
/// ("ESCROW", "refunded", escrow_id) and payload
/// (payer, refund_to, token, amount).
/// refund_to == payer when no explicit destination was set.
#[test]
fn refund_emits_event_with_correct_topic_and_payload() {
    let env = Env::default();
    env.mock_all_auths();
    let f = funded_escrow(&env, 300);

    // refund is the last call.
    f.client.refund(&f.escrow_id, &f.releaser);

    assert_eq!(
        env.events().all().filter_by_contract(&f.contract_id),
        vec![
            &env,
            (
                f.contract_id.clone(),
                (
                    symbol_short!("ESCROW"),
                    symbol_short!("refunded"),
                    f.escrow_id,
                )
                    .into_val(&env),
                (f.payer.clone(), f.payer.clone(), f.token_id.clone(), 300i128).into_val(&env),
            ),
        ]
    );
}

/// refund with an explicit refund_to must use that address as destination in
/// the event payload.
#[test]
fn refund_event_destination_is_refund_to_not_payer() {
    let env = Env::default();
    env.mock_all_auths();

    let (token_id, _token, asset) = setup_token(&env);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    let refund_to = Address::generate(&env); // distinct from payer
    asset.mint(&payer, &1_000);

    let contract_id = env.register(EscrowContract, (Vec::<Address>::new(&env),));
    let client = EscrowContractClient::new(&env, &contract_id);

    let escrow_id = client.create_escrow(
        &payer,
        &payee,
        &token_id,
        &400,
        &String::from_str(&env, "opaque-ref"),
        &releaser,
        &None,
        &false,
        &Some(refund_to.clone()),
    );

    // refund is the last call — its events are captured.
    client.refund(&escrow_id, &releaser);

    assert_eq!(
        env.events().all().filter_by_contract(&contract_id),
        vec![
            &env,
            (
                contract_id.clone(),
                (symbol_short!("ESCROW"), symbol_short!("refunded"), escrow_id).into_val(&env),
                (payer.clone(), refund_to.clone(), token_id.clone(), 400i128).into_val(&env),
            ),
        ]
    );
}

/// Error path: refund by an unauthorized caller emits no event.
#[test]
fn refund_unauthorized_emits_no_event() {
    let env = Env::default();
    env.mock_all_auths();
    let f = funded_escrow(&env, 300);
    let stranger = Address::generate(&env);

    // The failed try_refund is the last call; its buffer must be empty.
    let _ = f.client.try_refund(&f.escrow_id, &stranger);

    assert_eq!(
        env.events()
            .all()
            .filter_by_contract(&f.contract_id)
            .events()
            .len(),
        0,
        "unauthorized refund must not emit any events"
    );
}

/// Error path: refund on an already-settled escrow emits no event.
#[test]
fn refund_on_settled_escrow_emits_no_event() {
    let env = Env::default();
    env.mock_all_auths();
    let f = funded_escrow(&env, 300);

    // First refund succeeds.
    f.client.refund(&f.escrow_id, &f.releaser);

    // Second refund on the already-Refunded escrow must fail without emitting.
    let _ = f.client.try_refund(&f.escrow_id, &f.releaser);

    // The failed second try_refund is the last call — its buffer must be empty.
    assert_eq!(
        env.events()
            .all()
            .filter_by_contract(&f.contract_id)
            .events()
            .len(),
        0,
        "a failed second refund must not emit any event"
    );
}

/// Error path: release on an unknown escrow id emits no event.
#[test]
fn release_unknown_escrow_emits_no_event() {
    let env = Env::default();
    env.mock_all_auths();
    let f = funded_escrow(&env, 300);

    let _ = f.client.try_release(&999_999, &f.releaser);

    assert_eq!(
        env.events()
            .all()
            .filter_by_contract(&f.contract_id)
            .events()
            .len(),
        0,
        "release on unknown escrow id must not emit any events"
    );
}

/// Error path: refund on an unknown escrow id emits no event.
#[test]
fn refund_unknown_escrow_emits_no_event() {
    let env = Env::default();
    env.mock_all_auths();
    let f = funded_escrow(&env, 300);

    let _ = f.client.try_refund(&999_999, &f.releaser);

    assert_eq!(
        env.events()
            .all()
            .filter_by_contract(&f.contract_id)
            .events()
            .len(),
        0,
        "refund on unknown escrow id must not emit any events"
    );
}

/// Happy path: timeout refund after deadline emits a "refunded" event.
#[test]
fn timeout_refund_after_deadline_emits_refunded_event() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let (token_id, _token, asset) = setup_token(&env);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    let stranger = Address::generate(&env);
    asset.mint(&payer, &1_000);

    let contract_id = env.register(EscrowContract, (Vec::<Address>::new(&env),));
    let client = EscrowContractClient::new(&env, &contract_id);

    let deadline = 1_100u64;
    let escrow_id = client.create_escrow(
        &payer,
        &payee,
        &token_id,
        &500,
        &String::from_str(&env, "opaque-ref"),
        &releaser,
        &Some(deadline),
        &false,
        &None,
    );

    // Advance past deadline — stranger is authorized to trigger timeout refund.
    env.ledger().set_timestamp(deadline + 1);
    client.refund(&escrow_id, &stranger);

    assert_eq!(
        env.events().all().filter_by_contract(&contract_id),
        vec![
            &env,
            (
                contract_id.clone(),
                (symbol_short!("ESCROW"), symbol_short!("refunded"), escrow_id).into_val(&env),
                (payer.clone(), payer.clone(), token_id.clone(), 500i128).into_val(&env),
            ),
        ]
    );
}

/// Happy path: release_with_approvals on an M-of-N escrow emits "released" event.
#[test]
fn release_with_approvals_emits_released_event() {
    let env = Env::default();
    env.mock_all_auths();

    let (token_id, _token, asset) = setup_token(&env);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let r1 = Address::generate(&env);
    let r2 = Address::generate(&env);
    asset.mint(&payer, &1_000);

    let contract_id = env.register(EscrowContract, (Vec::<Address>::new(&env),));
    let client = EscrowContractClient::new(&env, &contract_id);

    let mut releasers = Vec::new(&env);
    releasers.push_back(r1.clone());
    releasers.push_back(r2.clone());

    let escrow_id = client.create_escrow_with_releasers(
        &payer,
        &payee,
        &token_id,
        &350,
        &String::from_str(&env, "quorum-ref"),
        &releasers,
        &2, // threshold = 2 of 2
        &None,
        &false,
        &None,
    );

    let mut approvers = Vec::new(&env);
    approvers.push_back(r1.clone());
    approvers.push_back(r2.clone());

    client.release_with_approvals(&escrow_id, &approvers);

    assert_eq!(
        env.events().all().filter_by_contract(&contract_id),
        vec![
            &env,
            (
                contract_id.clone(),
                (symbol_short!("ESCROW"), symbol_short!("released"), escrow_id).into_val(&env),
                (payer.clone(), payee.clone(), token_id.clone(), 350i128).into_val(&env),
            ),
        ]
    );
}
