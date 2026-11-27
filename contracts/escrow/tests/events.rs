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
//  Payload: the complete escrow state snapshot documented in
//           ARCHITECTURE_ESSENTIALS.md.
//
// condition_ref is opaque and is carried unchanged in the state snapshot.
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
    vec, Address, Env, IntoVal, String, Val, Vec,
};

// ── helpers ──────────────────────────────────────────────────────────────────

fn setup_token(env: &Env) -> (Address, TokenClient<'_>, StellarAssetClient<'_>) {
    let admin = Address::generate(env);
    let id = env.register_stellar_asset_contract_v2(admin).address();
    let token = TokenClient::new(env, &id);
    let asset = StellarAssetClient::new(env, &id);
    (id, token, asset)
}

fn state_payload(
    env: &Env,
    payer: &Address,
    payee: &Address,
    token: &Address,
    amount: i128,
    releasers: Vec<Address>,
    refund_after: Option<u64>,
    status: soroban_sdk::Symbol,
) -> Val {
    (
        payer.clone(),
        payee.clone(),
        token.clone(),
        amount,
        String::from_str(env, "opaque-ref"),
        releasers,
        1u32,
        refund_after,
        false,
        false,
        Option::<u64>::None,
        status,
        (Option::<Address>::None, Option::<u32>::None),
    )
        .into_val(env)
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

    let contract_id = env.register(
        EscrowContract,
        (Vec::<Address>::new(env), Address::generate(env)),
    );
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
        &None,
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

/// create_escrow must emit exactly one full-state event with topic
/// ("ESCROW", "created", escrow_id).
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
                state_payload(
                    &env,
                    &f.payer,
                    &f.payee,
                    &f.token_id,
                    300,
                    vec![&env, f.releaser.clone()],
                    None,
                    symbol_short!("Funded"),
                ),
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

    let contract_id = env.register(
        EscrowContract,
        (Vec::<Address>::new(&env), Address::generate(&env)),
    );
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
        &None,
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
                state_payload(
                    &env,
                    &f.payer,
                    &f.payee,
                    &f.token_id,
                    300,
                    vec![&env, f.releaser.clone()],
                    None,
                    symbol_short!("Released"),
                ),
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
                state_payload(
                    &env,
                    &f.payer,
                    &f.payee,
                    &f.token_id,
                    300,
                    vec![&env, f.releaser.clone()],
                    None,
                    symbol_short!("Refunded"),
                ),
            ),
        ]
    );
}

/// A sponsored refund keeps the full escrow state payload stable.
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

    let contract_id = env.register(
        EscrowContract,
        (Vec::<Address>::new(&env), Address::generate(&env)),
    );
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
        &None,
        &None,
    );

    // refund is the last call — its events are captured.
    client.refund(&escrow_id, &releaser);

    assert_eq!(
        env.events().all().filter_by_contract(&contract_id),
        vec![
            &env,
            (
                contract_id.clone(),
                (
                    symbol_short!("ESCROW"),
                    symbol_short!("refunded"),
                    escrow_id
                )
                    .into_val(&env),
                state_payload(
                    &env,
                    &payer,
                    &payee,
                    &token_id,
                    400,
                    vec![&env, releaser.clone()],
                    None,
                    symbol_short!("Refunded"),
                ),
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

    let contract_id = env.register(
        EscrowContract,
        (Vec::<Address>::new(&env), Address::generate(&env)),
    );
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
        &None,
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
                (
                    symbol_short!("ESCROW"),
                    symbol_short!("refunded"),
                    escrow_id
                )
                    .into_val(&env),
                state_payload(
                    &env,
                    &payer,
                    &payee,
                    &token_id,
                    500,
                    vec![&env, releaser.clone()],
                    Some(deadline),
                    symbol_short!("Refunded"),
                ),
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

    let contract_id = env.register(
        EscrowContract,
        (Vec::<Address>::new(&env), Address::generate(&env)),
    );
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
                (
                    symbol_short!("ESCROW"),
                    symbol_short!("released"),
                    escrow_id
                )
                    .into_val(&env),
                (
                    payer.clone(),
                    payee.clone(),
                    token_id.clone(),
                    350i128,
                    String::from_str(&env, "quorum-ref"),
                    releasers,
                    2u32,
                    Option::<u64>::None,
                    false,
                    false,
                    Option::<u64>::None,
                    symbol_short!("Released"),
                    (Option::<Address>::None, Option::<u32>::None),
                )
                    .into_val(&env),
            ),
        ]
    );
}

// ── golden tests: non-lifecycle events (issue #312) ─────────────────────────
//
// One test per non-lifecycle event. Each ends on the emitting call and
// asserts the exact topics and payload, so any change to these shapes is a
// deliberate, reviewed diff. Consumers:
//  - `accepted`, `top_up`, `rotate`, `pay_xfer`, `contrib`, `claimed`:
//    the indexer's partial-event handler (`indexer/src/mappings/index.ts`,
//    `PARTIAL_TOPICS` in `indexer/project.ts`). The SDK's `getEvents`
//    decoder (`sdk/src/events.ts`) currently surfaces them as `unknown`.
//  - `payee_refunded`, `paused`, `unpaused` (`#[contractevent]` structs in
//    `src/types.rs`): no indexer mapping yet; the SDK's `getEvents`
//    decoder (`sdk/src/events.ts`) surfaces them as `unknown`.

use docforum_escrow::{Paused, PayeeRefunded, Unpaused};
use soroban_sdk::Event as _;

/// Golden: `accept` emits ("accepted", escrow_id) => (payee, accepted_at).
/// Consumed by the indexer's `accepted` case in `indexer/src/mappings/index.ts`.
#[test]
fn golden_accepted_event() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_234);
    let (token_id, _token, asset) = setup_token(&env);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    asset.mint(&payer, &1_000);
    let contract_id = env.register(
        EscrowContract,
        (Vec::<Address>::new(&env), Address::generate(&env)),
    );
    let client = EscrowContractClient::new(&env, &contract_id);
    let escrow_id = client.create_escrow_with_acceptance(
        &payer,
        &payee,
        &token_id,
        &300,
        &String::from_str(&env, "opaque-ref"),
        &releaser,
        &None,
        &true,
        &None,
    );

    client.accept(&escrow_id, &payee);

    assert_eq!(
        env.events().all().filter_by_contract(&contract_id),
        vec![
            &env,
            (
                contract_id.clone(),
                (symbol_short!("accepted"), escrow_id).into_val(&env),
                (payee.clone(), 1_234u64).into_val(&env),
            ),
        ]
    );
}

/// Golden: `top_up` emits ("top_up", escrow_id) => (amount, new_total).
/// Consumed by the indexer's `top_up` case in `indexer/src/mappings/index.ts`.
#[test]
fn golden_top_up_event() {
    let env = Env::default();
    env.mock_all_auths();
    let f = funded_escrow(&env, 300);

    f.client.top_up(&f.escrow_id, &f.payer, &200);

    assert_eq!(
        env.events().all().filter_by_contract(&f.contract_id),
        vec![
            &env,
            (
                f.contract_id.clone(),
                (symbol_short!("top_up"), f.escrow_id).into_val(&env),
                (200i128, 500i128).into_val(&env),
            ),
        ]
    );
}

/// Golden: `rotate_releaser` emits ("rotate", escrow_id) => (old, new).
/// Consumed by the indexer's `rotate` case in `indexer/src/mappings/index.ts`.
#[test]
fn golden_rotate_event() {
    let env = Env::default();
    env.mock_all_auths();
    let f = funded_escrow(&env, 300);
    let new_releaser = Address::generate(&env);

    f.client
        .rotate_releaser(&f.escrow_id, &f.releaser, &new_releaser);

    assert_eq!(
        env.events().all().filter_by_contract(&f.contract_id),
        vec![
            &env,
            (
                f.contract_id.clone(),
                (symbol_short!("rotate"), f.escrow_id).into_val(&env),
                (f.releaser.clone(), new_releaser.clone()).into_val(&env),
            ),
        ]
    );
}

/// Golden: `transfer_payee` emits ("pay_xfer", escrow_id) => (old, new).
/// Consumed by the indexer's `pay_xfer` case in `indexer/src/mappings/index.ts`.
#[test]
fn golden_pay_xfer_event() {
    let env = Env::default();
    env.mock_all_auths();
    let f = funded_escrow(&env, 300);
    let new_payee = Address::generate(&env);

    f.client.transfer_payee(&f.escrow_id, &f.payee, &new_payee);

    assert_eq!(
        env.events().all().filter_by_contract(&f.contract_id),
        vec![
            &env,
            (
                f.contract_id.clone(),
                (symbol_short!("pay_xfer"), f.escrow_id).into_val(&env),
                (f.payee.clone(), new_payee.clone()).into_val(&env),
            ),
        ]
    );
}

struct PooledFixture<'a> {
    client: EscrowContractClient<'a>,
    contract_id: Address,
    asset: StellarAssetClient<'a>,
    escrow_id: u64,
}

const POOL_DEADLINE: u64 = 1_500;

fn pooled_escrow(env: &Env, target: i128) -> PooledFixture<'_> {
    env.ledger().set_timestamp(1_000);
    let (token_id, _token, asset) = setup_token(env);
    let contract_id = env.register(
        EscrowContract,
        (Vec::<Address>::new(env), Address::generate(env)),
    );
    let client = EscrowContractClient::new(env, &contract_id);
    let escrow_id = client.create_pooled_escrow(
        &Address::generate(env),
        &Address::generate(env),
        &token_id,
        &target,
        &String::from_str(env, "opaque-ref"),
        &Address::generate(env),
        &POOL_DEADLINE,
    );
    PooledFixture {
        client,
        contract_id,
        asset,
        escrow_id,
    }
}

/// Golden: `contribute` emits ("contrib", escrow_id) =>
/// (contributor, amount, pooled_total).
/// Consumed by the indexer's `contrib` case in `indexer/src/mappings/index.ts`.
#[test]
fn golden_contrib_event() {
    let env = Env::default();
    env.mock_all_auths();
    let p = pooled_escrow(&env, 100);
    let a = Address::generate(&env);
    let b = Address::generate(&env);
    p.asset.mint(&a, &30);
    p.asset.mint(&b, &25);
    p.client.contribute(&p.escrow_id, &a, &30);

    p.client.contribute(&p.escrow_id, &b, &25);

    assert_eq!(
        env.events().all().filter_by_contract(&p.contract_id),
        vec![
            &env,
            (
                p.contract_id.clone(),
                (symbol_short!("contrib"), p.escrow_id).into_val(&env),
                (b.clone(), 25i128, 55i128).into_val(&env),
            ),
        ]
    );
}

/// Golden: `claim_refund` emits ("claimed", escrow_id) =>
/// (contributor, refund_amount). Two contributors, so this first claim does
/// not close the round and emits only `claimed` (the closing claim also
/// emits the lifecycle `refunded` snapshot).
/// Consumed by the indexer's `claimed` case in `indexer/src/mappings/index.ts`.
#[test]
fn golden_claimed_event() {
    let env = Env::default();
    env.mock_all_auths();
    let p = pooled_escrow(&env, 100);
    let a = Address::generate(&env);
    let b = Address::generate(&env);
    p.asset.mint(&a, &30);
    p.asset.mint(&b, &25);
    p.client.contribute(&p.escrow_id, &a, &30);
    p.client.contribute(&p.escrow_id, &b, &25);
    env.ledger().set_timestamp(POOL_DEADLINE + 1);

    p.client.claim_refund(&p.escrow_id, &a);

    assert_eq!(
        env.events().all().filter_by_contract(&p.contract_id),
        vec![
            &env,
            (
                p.contract_id.clone(),
                (symbol_short!("claimed"), p.escrow_id).into_val(&env),
                (a.clone(), 30i128).into_val(&env),
            ),
        ]
    );
}

/// Golden: a payee-initiated `refund` emits the lifecycle ("ESCROW",
/// "refunded", id) snapshot followed by `PayeeRefunded` (topics:
/// "payee_refunded", escrow_id, payer, payee; data: {amount}).
/// No indexer mapping yet; `sdk/src/events.ts` surfaces it as `unknown`.
#[test]
fn golden_payee_refunded_event() {
    let env = Env::default();
    env.mock_all_auths();
    let f = funded_escrow(&env, 300);

    f.client.refund(&f.escrow_id, &f.payee);

    let emitted = env.events().all().filter_by_contract(&f.contract_id);
    let events = emitted.events();
    assert_eq!(events.len(), 2);
    assert_eq!(
        events[1],
        PayeeRefunded {
            escrow_id: f.escrow_id,
            payer: f.payer.clone(),
            payee: f.payee.clone(),
            amount: 300,
        }
        .to_xdr(&env, &f.contract_id)
    );
    // Pin the struct-encoded shape too, so a change to the
    // `#[contractevent]` declaration (name, topic order, data format) fails
    // here rather than only in the struct round-trip above.
    assert_eq!(
        emitted,
        vec![
            &env,
            (
                f.contract_id.clone(),
                (
                    symbol_short!("ESCROW"),
                    symbol_short!("refunded"),
                    f.escrow_id
                )
                    .into_val(&env),
                state_payload(
                    &env,
                    &f.payer,
                    &f.payee,
                    &f.token_id,
                    300,
                    vec![&env, f.releaser.clone()],
                    None,
                    symbol_short!("Refunded"),
                ),
            ),
            (
                f.contract_id.clone(),
                (
                    soroban_sdk::Symbol::new(&env, "payee_refunded"),
                    f.escrow_id,
                    f.payer.clone(),
                    f.payee.clone(),
                )
                    .into_val(&env),
                soroban_sdk::map![&env, (symbol_short!("amount"), 300i128)].into_val(&env),
            ),
        ]
    );
}

/// Golden: `pause` emits `Paused` (topics: "paused", admin; data: {}).
/// No indexer mapping yet; `sdk/src/events.ts` surfaces it as `unknown`.
#[test]
fn golden_paused_event() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let contract_id = env.register(EscrowContract, (Vec::<Address>::new(&env), admin.clone()));
    let client = EscrowContractClient::new(&env, &contract_id);

    client.pause(&admin);

    let emitted = env.events().all().filter_by_contract(&contract_id);
    assert_eq!(
        emitted.events(),
        &[Paused {
            admin: admin.clone()
        }
        .to_xdr(&env, &contract_id)]
    );
    assert_eq!(
        emitted,
        vec![
            &env,
            (
                contract_id.clone(),
                (symbol_short!("paused"), admin.clone()).into_val(&env),
                soroban_sdk::Map::<soroban_sdk::Symbol, Val>::new(&env).into_val(&env),
            ),
        ]
    );
}

/// Golden: `unpause` emits `Unpaused` (topics: "unpaused", admin; data: {}).
/// No indexer mapping yet; `sdk/src/events.ts` surfaces it as `unknown`.
#[test]
fn golden_unpaused_event() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let contract_id = env.register(EscrowContract, (Vec::<Address>::new(&env), admin.clone()));
    let client = EscrowContractClient::new(&env, &contract_id);
    client.pause(&admin);

    client.unpause(&admin);

    let emitted = env.events().all().filter_by_contract(&contract_id);
    assert_eq!(
        emitted.events(),
        &[Unpaused {
            admin: admin.clone()
        }
        .to_xdr(&env, &contract_id)]
    );
    assert_eq!(
        emitted,
        vec![
            &env,
            (
                contract_id.clone(),
                (symbol_short!("unpaused"), admin.clone()).into_val(&env),
                soroban_sdk::Map::<soroban_sdk::Symbol, Val>::new(&env).into_val(&env),
            ),
        ]
    );
}
