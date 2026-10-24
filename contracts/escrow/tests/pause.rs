// Phase E5 tests — the emergency pause that can only stop NEW escrows
// (issue #35, docs/adr/0011). Per AGENTS.md hard rule 2: contract logic
// changes need tests here before merge, not a follow-up.
//
// The review criterion for this feature is a negative one: **every**
// outbound-funds path must be provably unaffected by the pause. So this
// file tests both halves:
//   - paused blocks every deposit path (`create_escrow`, its variants,
//     `top_up`, `create_pooled_escrow` and `contribute`) and locks nothing
//     while doing so;
//   - paused does NOT block `release`, `refund`, the ADR 0004 timeout
//     refund or pooled `claim_refund` — including release after the
//     deadline and a long pause.
// plus the role itself (custodian set at deploy, its auth, events, and
// pause/unpause state errors).

use docforum_escrow::{
    Error, EscrowContract, EscrowContractClient, EscrowStatus, Paused, Unpaused,
};
use soroban_sdk::{
    events::Event as _,
    testutils::{Address as _, Events as _, Ledger as _, MockAuth, MockAuthInvoke},
    token::{StellarAssetClient, TokenClient},
    Address, Env, IntoVal, InvokeError, String, Vec,
};

/// Ledger close time at escrow creation.
const CREATED_AT: u64 = 1_000;
/// The escrow's optional timeout deadline — always strictly after CREATED_AT.
const DEADLINE: u64 = 1_100;

fn setup_asset<'a>(env: &Env) -> (Address, TokenClient<'a>, StellarAssetClient<'a>) {
    let admin = Address::generate(env);
    let contract_id = env.register_stellar_asset_contract_v2(admin);
    let token = TokenClient::new(env, &contract_id.address());
    let asset = StellarAssetClient::new(env, &contract_id.address());
    (contract_id.address(), token, asset)
}

struct Fixture<'a> {
    client: EscrowContractClient<'a>,
    token: TokenClient<'a>,
    token_id: Address,
    contract_id: Address,
    /// The address set by `__constructor` — the only one that may pause.
    custodian: Address,
    payer: Address,
    payee: Address,
    releaser: Address,
}

fn deploy<'a>(env: &'a Env) -> Fixture<'a> {
    env.ledger().set_timestamp(CREATED_AT);

    let (token_id, token, asset) = setup_asset(env);
    let custodian = Address::generate(env);
    let payer = Address::generate(env);
    let payee = Address::generate(env);
    let releaser = Address::generate(env);
    asset.mint(&payer, &1_000);

    let contract_id = env.register(
        EscrowContract,
        (Vec::<Address>::new(env), custodian.clone()),
    );
    let client = EscrowContractClient::new(env, &contract_id);

    Fixture {
        client,
        token,
        token_id,
        contract_id,
        custodian,
        payer,
        payee,
        releaser,
    }
}

/// Creates one escrow of `amount` from the fixture's payer/payee/releaser.
fn create(env: &Env, f: &Fixture, amount: i128, refund_after: Option<u64>) -> u64 {
    f.client.create_escrow(
        &f.payer,
        &f.payee,
        &f.token_id,
        &amount,
        &String::from_str(env, "opaque-condition-ref"),
        &f.releaser,
        &refund_after,
        &false,
        &None,
    )
}

/// Asserts a `try_*` call failed with the *contract* error `expected`
/// (as opposed to an auth/host failure), and returns nothing.
fn assert_contract_error<T: core::fmt::Debug, E: core::fmt::Debug>(
    result: Result<Result<T, E>, Result<Error, InvokeError>>,
    expected: Error,
) {
    match result {
        Err(Ok(err)) => assert_eq!(err, expected),
        other => panic!("expected contract error {expected:?}, got {other:?}"),
    }
}

// --- deploy-time configuration: constructor ---

#[test]
fn constructor_stores_the_custodian_and_starts_unpaused() {
    let env = Env::default();
    env.mock_all_auths();
    let f = deploy(&env);

    assert_eq!(f.client.get_pause_admin(), Some(f.custodian.clone()));
    assert!(!f.client.is_paused());
}

// --- pause / unpause happy paths + events ---

#[test]
fn pause_blocks_new_deposits_and_emits_an_event() {
    let env = Env::default();
    env.mock_all_auths();
    let f = deploy(&env);

    f.client.pause(&f.custodian);

    // The event carries the custodian that flipped the flag, so monitoring
    // can react without polling (docs/adr/0011, threat model T7). Read it
    // first: `env.events().all()` only covers the *last* invocation, and
    // `is_paused` below would replace it.
    let emitted = env.events().all().filter_by_contract(&f.contract_id);
    let expected = Paused {
        admin: f.custodian.clone(),
    }
    .to_xdr(&env, &f.contract_id);
    assert_eq!(emitted.events(), &[expected]);

    assert!(f.client.is_paused());
}

#[test]
fn unpause_reopens_deposits_and_emits_an_event() {
    let env = Env::default();
    env.mock_all_auths();
    let f = deploy(&env);

    f.client.pause(&f.custodian);
    f.client.unpause(&f.custodian);

    // Read the event before anything else invokes the contract
    // (`env.events().all()` covers only the last invocation).
    let emitted = env.events().all().filter_by_contract(&f.contract_id);
    let expected = Unpaused {
        admin: f.custodian.clone(),
    }
    .to_xdr(&env, &f.contract_id);
    assert_eq!(emitted.events(), &[expected]);

    assert!(!f.client.is_paused());

    // And deposits actually work again.
    assert_eq!(create(&env, &f, 300, None), 0);
    assert_eq!(f.token.balance(&f.contract_id), 300);
}

#[test]
fn pause_twice_is_rejected_without_a_second_event() {
    let env = Env::default();
    env.mock_all_auths();
    let f = deploy(&env);

    f.client.pause(&f.custodian);
    assert_contract_error(f.client.try_pause(&f.custodian), Error::AlreadyPaused);

    // A rejected call emits nothing and leaves the flag set.
    assert!(f.client.is_paused());
    let emitted = env.events().all().filter_by_contract(&f.contract_id);
    assert!(emitted.events().is_empty());
}

#[test]
fn unpause_when_not_paused_is_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let f = deploy(&env);

    assert_contract_error(f.client.try_unpause(&f.custodian), Error::NotPaused);
    assert!(!f.client.is_paused());
}

// --- the role: only the deploy-time custodian, and it must sign ---

#[test]
fn pause_and_unpause_reject_everyone_but_the_custodian() {
    let env = Env::default();
    env.mock_all_auths();
    let f = deploy(&env);
    let stranger = Address::generate(&env);

    // Payer, payee, releaser and a stranger are all equally unauthorised.
    for outsider in [&f.payer, &f.payee, &f.releaser, &stranger] {
        assert_contract_error(f.client.try_pause(outsider), Error::Unauthorized);
    }
    assert!(!f.client.is_paused());

    f.client.pause(&f.custodian);

    for outsider in [&f.payer, &f.payee, &f.releaser, &stranger] {
        assert_contract_error(f.client.try_unpause(outsider), Error::Unauthorized);
    }
    assert!(f.client.is_paused());
}

#[test]
fn pause_requires_the_custodian_s_own_signature() {
    let env = Env::default();
    env.mock_all_auths();
    let f = deploy(&env);

    // Only the payer's auth is mocked from here on, so a call *by* the
    // custodian is unsigned and `require_auth` must reject it — the check
    // is more than comparing addresses (docs/adr/0011).
    env.mock_auths(&[MockAuth {
        address: &f.payer,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "pause",
            args: (&f.custodian,).into_val(&env),
            sub_invokes: &[],
        },
    }]);

    assert!(f.client.try_pause(&f.custodian).is_err());
    assert!(!f.client.is_paused());
}

// --- paused blocks every deposit path, and touches nothing ---

#[test]
fn paused_create_escrow_fails_with_paused_and_locks_no_funds() {
    let env = Env::default();
    env.mock_all_auths();
    let f = deploy(&env);
    f.client.pause(&f.custodian);

    assert_contract_error(
        f.client.try_create_escrow(
            &f.payer,
            &f.payee,
            &f.token_id,
            &300,
            &String::from_str(&env, "blocked-ref"),
            &f.releaser,
            &None,
            &false,
            &None,
        ),
        Error::Paused,
    );

    // Nothing moved, nothing was stored, and no id was consumed: the
    // rejection happens before the transfer and before `next_id`.
    assert_eq!(f.token.balance(&f.payer), 1_000);
    assert_eq!(f.token.balance(&f.contract_id), 0);
    assert!(f.client.try_get_status(&0).is_err());
}

#[test]
fn paused_blocks_the_other_creation_entry_points_and_top_up() {
    let env = Env::default();
    env.mock_all_auths();
    let f = deploy(&env);
    let escrow_id = create(&env, &f, 100, None);
    f.client.pause(&f.custodian);

    // The M-of-N and acceptance entry points funnel through the same
    // creation path, so they are paused too (docs/adr/0011).
    let mut releasers = Vec::new(&env);
    releasers.push_back(f.releaser.clone());
    assert_contract_error(
        f.client.try_create_escrow_with_releasers(
            &f.payer,
            &f.payee,
            &f.token_id,
            &100,
            &String::from_str(&env, "blocked-quorum"),
            &releasers,
            &1,
            &None,
            &false,
            &None,
        ),
        Error::Paused,
    );
    assert_contract_error(
        f.client.try_create_escrow_with_acceptance(
            &f.payer,
            &f.payee,
            &f.token_id,
            &100,
            &String::from_str(&env, "blocked-acceptance"),
            &f.releaser,
            &None,
            &true,
            &None,
        ),
        Error::Paused,
    );

    // `top_up` is a deposit path as well: blocked before it transfers.
    assert_contract_error(
        f.client.try_top_up(&escrow_id, &f.payer, &100),
        Error::Paused,
    );

    assert_eq!(f.token.balance(&f.payer), 900);
    assert_eq!(f.token.balance(&f.contract_id), 100);
}

#[test]
fn paused_rejections_do_not_consume_escrow_ids() {
    let env = Env::default();
    env.mock_all_auths();
    let f = deploy(&env);

    let first = create(&env, &f, 100, None);
    f.client.pause(&f.custodian);
    for _ in 0..3 {
        assert!(f
            .client
            .try_create_escrow(
                &f.payer,
                &f.payee,
                &f.token_id,
                &100,
                &String::from_str(&env, "blocked-ref"),
                &f.releaser,
                &None,
                &false,
                &None,
            )
            .is_err());
    }
    f.client.unpause(&f.custodian);

    assert_eq!(first, 0);
    assert_eq!(create(&env, &f, 100, None), 1);
}

// --- EVERY outbound path still works while paused (the whole point) ---

#[test]
fn release_still_pays_the_payee_while_paused() {
    let env = Env::default();
    env.mock_all_auths();
    let f = deploy(&env);
    let escrow_id = create(&env, &f, 300, None);

    f.client.pause(&f.custodian);
    f.client.release(&escrow_id, &f.releaser);

    assert_eq!(f.token.balance(&f.payee), 300);
    assert_eq!(f.token.balance(&f.contract_id), 0);
    assert_eq!(f.client.get_status(&escrow_id), EscrowStatus::Released);
}

#[test]
fn releaser_refund_still_returns_funds_to_the_payer_while_paused() {
    let env = Env::default();
    env.mock_all_auths();
    let f = deploy(&env);
    let escrow_id = create(&env, &f, 300, None);

    f.client.pause(&f.custodian);
    f.client.refund(&escrow_id, &f.releaser);

    assert_eq!(f.token.balance(&f.payer), 1_000);
    assert_eq!(f.token.balance(&f.contract_id), 0);
    assert_eq!(f.client.get_status(&escrow_id), EscrowStatus::Refunded);
}

#[test]
fn timeout_refund_by_a_stranger_still_works_while_paused() {
    let env = Env::default();
    env.mock_all_auths();
    let f = deploy(&env);
    let stranger = Address::generate(&env);
    let escrow_id = create(&env, &f, 300, Some(DEADLINE));

    f.client.pause(&f.custodian);
    env.ledger().set_timestamp(DEADLINE);
    f.client.refund(&escrow_id, &stranger);

    // Back to the payer, never to the stranger — the pause changes nothing
    // about who may call or where funds go.
    assert_eq!(f.token.balance(&f.payer), 1_000);
    assert_eq!(f.token.balance(&stranger), 0);
    assert_eq!(f.client.get_status(&escrow_id), EscrowStatus::Refunded);
}

#[test]
fn releaser_can_still_release_after_the_deadline_while_paused() {
    let env = Env::default();
    env.mock_all_auths();
    let f = deploy(&env);
    let escrow_id = create(&env, &f, 300, Some(DEADLINE));

    f.client.pause(&f.custodian);
    env.ledger().set_timestamp(DEADLINE + 1);
    f.client.release(&escrow_id, &f.releaser);

    assert_eq!(f.token.balance(&f.payee), 300);
    assert_eq!(f.client.get_status(&escrow_id), EscrowStatus::Released);
}

#[test]
fn a_long_pause_never_traps_funds_already_escrowed() {
    let env = Env::default();
    env.mock_all_auths();
    let f = deploy(&env);
    let to_release = create(&env, &f, 300, None);
    let to_refund = create(&env, &f, 200, None);

    f.client.pause(&f.custodian);
    // Pause stays on for a year: both escrows must still be able to leave.
    env.ledger().set_timestamp(CREATED_AT + 365 * 24 * 60 * 60);

    f.client.release(&to_release, &f.releaser);
    f.client.refund(&to_refund, &f.releaser);

    // 1000 minted - 300 released - 200 escrowed + 200 refunded = 700.
    assert_eq!(f.token.balance(&f.payee), 300);
    assert_eq!(f.token.balance(&f.payer), 700);
    assert_eq!(f.token.balance(&f.contract_id), 0); // nothing stuck
    assert!(f.client.is_paused()); // and the pause is still on
}

#[test]
fn paused_does_not_change_stored_escrow_data_or_reads() {
    let env = Env::default();
    env.mock_all_auths();
    let f = deploy(&env);
    let escrow_id = create(&env, &f, 300, Some(DEADLINE));

    let before = f.client.get_escrow(&escrow_id);
    f.client.pause(&f.custodian);
    let after = f.client.get_escrow(&escrow_id);

    assert_eq!(before.payer, after.payer);
    assert_eq!(before.payee, after.payee);
    assert_eq!(before.token, after.token);
    assert_eq!(before.amount, after.amount);
    assert_eq!(before.condition_ref, after.condition_ref);
    assert_eq!(before.releasers, after.releasers);
    assert_eq!(before.threshold, after.threshold);
    assert_eq!(before.refund_after, after.refund_after);
    assert_eq!(after.status, EscrowStatus::Funded);
    assert_eq!(f.client.get_status(&escrow_id), EscrowStatus::Funded);
}

#[test]
fn a_settled_escrow_cannot_be_paid_twice_just_because_the_contract_is_paused() {
    let env = Env::default();
    env.mock_all_auths();
    let f = deploy(&env);
    let escrow_id = create(&env, &f, 300, None);
    f.client.release(&escrow_id, &f.releaser);

    f.client.pause(&f.custodian);

    // Status rules are unchanged by the pause: still exactly one payout.
    assert_contract_error(
        f.client.try_release(&escrow_id, &f.releaser),
        Error::NotFunded,
    );
    assert_contract_error(
        f.client.try_refund(&escrow_id, &f.releaser),
        Error::NotFunded,
    );
    assert_eq!(f.token.balance(&f.payee), 300);
    assert_eq!(f.token.balance(&f.contract_id), 0);
}

// --- pooled escrows (issue #113): same rule, new entry points ---
//
// `create_pooled_escrow` and `contribute` are deposit paths, so the pause
// blocks them. Pull-based `claim_refund` and `release` move money *out*,
// so a pause must never stop a failed round's refunds or a met target's
// payout.

/// Funding deadline for the pooled tests — strictly after CREATED_AT.
const FUNDING_DEADLINE: u64 = 1_500;

fn create_pooled(env: &Env, f: &Fixture, target: i128) -> u64 {
    f.client.create_pooled_escrow(
        &f.payer,
        &f.payee,
        &f.token_id,
        &target,
        &String::from_str(env, "pooled-condition"),
        &f.releaser,
        &FUNDING_DEADLINE,
    )
}

#[test]
fn paused_blocks_pooled_creation_and_contributions() {
    let env = Env::default();
    env.mock_all_auths();
    let f = deploy(&env);
    let pooled_id = create_pooled(&env, &f, 500);
    f.client.pause(&f.custodian);

    assert_contract_error(
        f.client.try_create_pooled_escrow(
            &f.payer,
            &f.payee,
            &f.token_id,
            &500,
            &String::from_str(&env, "blocked-pooled"),
            &f.releaser,
            &FUNDING_DEADLINE,
        ),
        Error::Paused,
    );
    assert_contract_error(
        f.client.try_contribute(&pooled_id, &f.payer, &100),
        Error::Paused,
    );

    // Nothing moved and nothing was recorded.
    assert_eq!(f.token.balance(&f.payer), 1_000);
    assert_eq!(f.token.balance(&f.contract_id), 0);
    assert_eq!(f.client.get_contribution(&pooled_id, &f.payer), None);

    // The rejected creation consumed no id.
    f.client.unpause(&f.custodian);
    assert_eq!(create(&env, &f, 100, None), pooled_id + 1);
}

#[test]
fn pooled_claim_refund_still_works_while_paused() {
    let env = Env::default();
    env.mock_all_auths();
    let f = deploy(&env);
    let pooled_id = create_pooled(&env, &f, 500);
    f.client.contribute(&pooled_id, &f.payer, &200);

    f.client.pause(&f.custodian);
    env.ledger().set_timestamp(FUNDING_DEADLINE);
    f.client.claim_refund(&pooled_id, &f.payer);

    assert_eq!(f.token.balance(&f.payer), 1_000);
    assert_eq!(f.token.balance(&f.contract_id), 0);
}

#[test]
fn fully_funded_pooled_escrow_still_releases_while_paused() {
    let env = Env::default();
    env.mock_all_auths();
    let f = deploy(&env);
    let pooled_id = create_pooled(&env, &f, 500);
    f.client.contribute(&pooled_id, &f.payer, &500);

    f.client.pause(&f.custodian);
    f.client.release(&pooled_id, &f.releaser);

    assert_eq!(f.token.balance(&f.payee), 500);
    assert_eq!(f.client.get_status(&pooled_id), EscrowStatus::Released);
}
