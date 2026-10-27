// Pooled escrows funded by multiple payers with pull-based pro-rata
// refunds — issue #113, docs/adr/0011.
//
// Scenario coverage (issue #113, step 13):
//   A  partial funding              -> partial_funding_records_and_blocks_release
//   B  target reached               -> reaching_the_target_releases_the_pooled_total
//   C  repeated contributor         -> repeated_contributions_accumulate_per_payer
//   D  multiple contributors        -> multiple_contributors_recorded_independently
//   E  refund to many payers        -> failed_round_refunds_every_contributor_exactly
//   F  refund ordering              -> refund_entitlements_are_order_independent
//   G  double refund                -> double_claim_is_rejected
//   H  unauthorized refund          -> contributor_cannot_claim_another_contributors_funds
//   I  failed funding deadline      -> failed_round_refunds_every_contributor_exactly
//   J  invalid contributions        -> invalid_contributions_are_rejected,
//                                      pooled_creation_validation
//   K  resource limits              -> no_contributor_cap_each_claim_is_independent
//   L  release safety               -> release_and_refund_can_never_share_funds
//   M  existing behavior            -> ordinary_escrows_are_unaffected,
//                                      push_paths_and_top_up_reject_pooled_escrows
//
// Every payout assertion checks real token balances, not just state
// fields (hard rule 2).

use docforum_escrow::{
    Contribution, Error, EscrowContract, EscrowContractClient, EscrowStatus, PooledData,
};
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Events as _, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    vec, Address, Env, IntoVal, String, Vec,
};

const CREATED_AT: u64 = 1_000;
const DEADLINE: u64 = 1_500;

struct Fixture<'a> {
    client: EscrowContractClient<'a>,
    token: TokenClient<'a>,
    asset: StellarAssetClient<'a>,
    contract_id: Address,
    creator: Address,
    payee: Address,
    releaser: Address,
    id: u64,
}

fn setup(env: &Env, target: i128) -> Fixture<'_> {
    env.mock_all_auths();
    env.ledger().set_timestamp(CREATED_AT);

    let token_id = env
        .register_stellar_asset_contract_v2(Address::generate(env))
        .address();
    let token = TokenClient::new(env, &token_id);
    let asset = StellarAssetClient::new(env, &token_id);
    let creator = Address::generate(env);
    let payee = Address::generate(env);
    let releaser = Address::generate(env);

    let contract_id = env.register(EscrowContract, (Vec::<Address>::new(env),));
    let client = EscrowContractClient::new(env, &contract_id);
    let id = client.create_pooled_escrow(
        &creator,
        &payee,
        &token_id,
        &target,
        &String::from_str(env, "pooled-condition"),
        &releaser,
        &DEADLINE,
    );
    Fixture {
        client,
        token,
        asset,
        contract_id,
        creator,
        payee,
        releaser,
        id,
    }
}

/// A fresh funded address ready to contribute.
fn contributor(f: &Fixture, env: &Env, mint: i128) -> Address {
    let addr = Address::generate(env);
    f.asset.mint(&addr, &mint);
    addr
}

fn record_of(f: &Fixture, addr: &Address) -> Option<Contribution> {
    f.client.get_contribution(&f.id, addr)
}

fn advance_past_deadline(env: &Env) {
    env.ledger().set_timestamp(DEADLINE);
}

// ---------------------------------------------------------------------------
// A — partial funding
// ---------------------------------------------------------------------------

#[test]
fn partial_funding_records_and_blocks_release() {
    let env = Env::default();
    let f = setup(&env, 100);
    let a = contributor(&f, &env, 30);

    f.client.contribute(&f.id, &a, &30);

    let data = f.client.get_escrow(&f.id);
    assert_eq!(data.amount, 30); // aggregate funded so far
    assert_eq!(data.status, EscrowStatus::Funded);

    let pooled: PooledData = f.client.get_pooled(&f.id);
    assert_eq!(pooled.funding_target, 100);
    assert_eq!(pooled.funding_deadline, DEADLINE);

    let record = record_of(&f, &a).expect("recorded");
    assert_eq!(record.amount, 30);
    assert!(!record.refunded);

    // Money really moved into the contract.
    assert_eq!(f.token.balance(&f.contract_id), 30);
    assert_eq!(f.token.balance(&a), 0);

    // Partial funding is never releasable, deadline or not.
    assert_eq!(
        f.client.try_release(&f.id, &f.releaser),
        Err(Ok(Error::FundingIncomplete))
    );
    // And refunds are not open yet — the round can still succeed.
    assert_eq!(
        f.client.try_claim_refund(&f.id, &a),
        Err(Ok(Error::RefundNotOpen))
    );
}

// ---------------------------------------------------------------------------
// B + I boundary — target reached releases the total; success is final
// ---------------------------------------------------------------------------

#[test]
fn reaching_the_target_releases_the_pooled_total() {
    let env = Env::default();
    let f = setup(&env, 100);
    let a = contributor(&f, &env, 40);
    let b = contributor(&f, &env, 35);
    let c = contributor(&f, &env, 25);
    let d = contributor(&f, &env, 1);

    f.client.contribute(&f.id, &a, &40);
    f.client.contribute(&f.id, &b, &35);
    f.client.contribute(&f.id, &c, &25);
    assert_eq!(f.client.get_escrow(&f.id).amount, 100);

    // Overfunding and post-target contributions are rejected outright.
    assert_eq!(
        f.client.try_contribute(&f.id, &d, &1),
        Err(Ok(Error::FundingTargetReached))
    );

    // Even after the deadline, a *successful* round releases: the target
    // was reached while the window was open.
    advance_past_deadline(&env);
    assert_eq!(
        f.client.try_contribute(&f.id, &d, &1),
        Err(Ok(Error::FundingDeadlinePassed))
    );
    // ...and it can never be refunded by anyone.
    assert_eq!(
        f.client.try_claim_refund(&f.id, &a),
        Err(Ok(Error::FundingTargetReached))
    );

    f.client.release(&f.id, &f.releaser);
    assert_eq!(f.client.get_status(&f.id), EscrowStatus::Released);
    // Release pays the whole pooled total to the payee — nothing less,
    // nothing more.
    assert_eq!(f.token.balance(&f.payee), 100);
    assert_eq!(f.token.balance(&f.contract_id), 0);
    // Released funds can never be claimed back by a contributor.
    assert_eq!(
        f.client.try_claim_refund(&f.id, &a),
        Err(Ok(Error::NotFunded))
    );
    assert_eq!(f.token.balance(&a), 0);
}

// ---------------------------------------------------------------------------
// C — repeated contributor
// ---------------------------------------------------------------------------

#[test]
fn repeated_contributions_accumulate_per_payer() {
    let env = Env::default();
    let f = setup(&env, 100);
    let a = contributor(&f, &env, 25);
    let b = contributor(&f, &env, 20);

    f.client.contribute(&f.id, &a, &10);
    f.client.contribute(&f.id, &b, &20);
    f.client.contribute(&f.id, &a, &15);

    let record_a = record_of(&f, &a).expect("recorded");
    let record_b = record_of(&f, &b).expect("recorded");
    // A must never see only its first contribution, nor more than the
    // combined recorded amount.
    assert_eq!(record_a.amount, 25);
    assert_eq!(record_b.amount, 20);
    assert_eq!(f.client.get_escrow(&f.id).amount, 45);
    assert_eq!(f.token.balance(&a), 0);
}

// ---------------------------------------------------------------------------
// D — multiple contributors
// ---------------------------------------------------------------------------

#[test]
fn multiple_contributors_recorded_independently() {
    let env = Env::default();
    let f = setup(&env, 100);
    let a = contributor(&f, &env, 40);
    let b = contributor(&f, &env, 35);
    let c = contributor(&f, &env, 25);
    let never = Address::generate(&env);

    f.client.contribute(&f.id, &a, &40);
    f.client.contribute(&f.id, &b, &35);
    f.client.contribute(&f.id, &c, &25);

    assert_eq!(record_of(&f, &a).unwrap().amount, 40);
    assert_eq!(record_of(&f, &b).unwrap().amount, 35);
    assert_eq!(record_of(&f, &c).unwrap().amount, 25);
    // An address that never contributed has no record at all.
    assert!(record_of(&f, &never).is_none());
}

// ---------------------------------------------------------------------------
// E + I — failed funding deadline: pull refunds to every contributor
// ---------------------------------------------------------------------------

#[test]
fn failed_round_refunds_every_contributor_exactly() {
    let env = Env::default();
    let f = setup(&env, 100);
    let a = contributor(&f, &env, 40);
    let b = contributor(&f, &env, 35);
    let c = contributor(&f, &env, 10);
    let stranger = Address::generate(&env);

    f.client.contribute(&f.id, &a, &40);
    f.client.contribute(&f.id, &b, &35);
    f.client.contribute(&f.id, &c, &10); // 85 of 100 — target missed

    advance_past_deadline(&env);

    // The round is over: no late money in, no payout out — but the funds
    // are not locked.
    assert_eq!(
        f.client.try_contribute(&f.id, &a, &1),
        Err(Ok(Error::FundingDeadlinePassed))
    );
    assert_eq!(
        f.client.try_release(&f.id, &f.releaser),
        Err(Ok(Error::FundingIncomplete))
    );

    f.client.claim_refund(&f.id, &c);
    f.client.claim_refund(&f.id, &a);
    f.client.claim_refund(&f.id, &b);

    // Exact token balances, not just state fields.
    assert_eq!(f.token.balance(&a), 40);
    assert_eq!(f.token.balance(&b), 35);
    assert_eq!(f.token.balance(&c), 10);
    assert_eq!(f.token.balance(&f.contract_id), 0);
    assert_eq!(f.token.balance(&f.payee), 0);
    // A failed round never settles: `get_status` still reports `Funded`
    // (settlement vocabulary), the funding state is `get_pooled`'s job.
    assert_eq!(f.client.get_status(&f.id), EscrowStatus::Funded);
    assert_eq!(f.client.get_escrow(&f.id).amount, 0);

    // Someone with no recorded contribution gets nothing.
    assert_eq!(
        f.client.try_claim_refund(&f.id, &stranger),
        Err(Ok(Error::NoContribution))
    );
}

// ---------------------------------------------------------------------------
// F — refund ordering
// ---------------------------------------------------------------------------

/// One failed round per order; the recorded amounts (40/35/25) are the
/// issue's example. Different claim orders must yield identical payouts.
fn run_refund_order(order: [u8; 3]) -> [i128; 3] {
    let env = Env::default();
    let f = setup(&env, 120); // target above the 100 funded — a failed round
    let a = contributor(&f, &env, 40);
    let b = contributor(&f, &env, 35);
    let c = contributor(&f, &env, 25);

    f.client.contribute(&f.id, &a, &40);
    f.client.contribute(&f.id, &b, &35);
    f.client.contribute(&f.id, &c, &25);
    advance_past_deadline(&env);

    let payers = [&a, &b, &c];
    for i in order {
        f.client.claim_refund(&f.id, payers[i as usize]);
    }

    assert_eq!(f.token.balance(&f.contract_id), 0);
    [
        f.token.balance(&a),
        f.token.balance(&b),
        f.token.balance(&c),
    ]
}

#[test]
fn refund_entitlements_are_order_independent() {
    // A, B, C then C, B, A and a mixed order: same entitlements always.
    assert_eq!(run_refund_order([0, 1, 2]), [40, 35, 25]);
    assert_eq!(run_refund_order([2, 1, 0]), [40, 35, 25]);
    assert_eq!(run_refund_order([1, 2, 0]), [40, 35, 25]);
}

// ---------------------------------------------------------------------------
// G — double refund
// ---------------------------------------------------------------------------

#[test]
fn double_claim_is_rejected() {
    let env = Env::default();
    let f = setup(&env, 100);
    let a = contributor(&f, &env, 30);

    f.client.contribute(&f.id, &a, &30);
    advance_past_deadline(&env);

    f.client.claim_refund(&f.id, &a);
    assert_eq!(f.token.balance(&a), 30);

    // Second attempt: rejected, and it moves no tokens.
    assert_eq!(
        f.client.try_claim_refund(&f.id, &a),
        Err(Ok(Error::AlreadyRefunded))
    );
    assert_eq!(f.token.balance(&a), 30);
    assert_eq!(f.token.balance(&f.contract_id), 0);
    let record = record_of(&f, &a).unwrap();
    assert!(record.refunded);
    assert_eq!(record.amount, 30);
}

// ---------------------------------------------------------------------------
// H — unauthorized refund
// ---------------------------------------------------------------------------

#[test]
fn contributor_cannot_claim_another_contributors_funds() {
    let env = Env::default();
    let f = setup(&env, 100);
    let victim = contributor(&f, &env, 30);
    let attacker = Address::generate(&env);

    f.client.contribute(&f.id, &victim, &30);
    advance_past_deadline(&env);

    // The attacker claiming "their own" (nonexistent) contribution.
    assert_eq!(
        f.client.try_claim_refund(&f.id, &attacker),
        Err(Ok(Error::NoContribution))
    );

    // The attacker claiming under the victim's address: `require_auth`
    // fails without the victim's signature, and nothing moves.
    env.mock_auths(&[]);
    assert!(f.client.try_claim_refund(&f.id, &victim).is_err());
    assert_eq!(f.token.balance(&victim), 0);
    assert_eq!(f.token.balance(&f.contract_id), 30);
    assert!(!record_of(&f, &victim).unwrap().refunded);
}

#[test]
fn claiming_requires_the_contributors_signature() {
    let env = Env::default();
    let f = setup(&env, 100);
    let a = contributor(&f, &env, 30);
    f.client.contribute(&f.id, &a, &30);
    advance_past_deadline(&env);

    // Blanket auth on, then drop every mocked auth: an unsigned claim is
    // refused outright.
    env.mock_auths(&[]);
    assert!(f.client.try_claim_refund(&f.id, &a).is_err());
    assert_eq!(f.token.balance(&a), 0);
    assert_eq!(f.token.balance(&f.contract_id), 30);
}

// ---------------------------------------------------------------------------
// J — invalid contributions and creation validation
// ---------------------------------------------------------------------------

#[test]
fn invalid_contributions_are_rejected() {
    let env = Env::default();
    let f = setup(&env, 100);
    let a = contributor(&f, &env, i128::MAX);

    // Zero and negative amounts.
    assert_eq!(
        f.client.try_contribute(&f.id, &a, &0),
        Err(Ok(Error::InvalidAmount))
    );
    assert_eq!(
        f.client.try_contribute(&f.id, &a, &-5),
        Err(Ok(Error::InvalidAmount))
    );
    // Overflow-sized amounts are rejected before anything is pulled —
    // they can never push the total past the target.
    assert_eq!(
        f.client.try_contribute(&f.id, &a, &i128::MAX),
        Err(Ok(Error::FundingTargetReached))
    );
    // Nothing was recorded or moved by any rejected attempt.
    assert!(record_of(&f, &a).is_none());
    assert_eq!(f.token.balance(&f.contract_id), 0);

    // Overfunding boundary: 90 in, 11 more rejected, exactly 10 accepted,
    // then nothing at all once the target is met.
    f.client.contribute(&f.id, &a, &90);
    assert_eq!(
        f.client.try_contribute(&f.id, &a, &11),
        Err(Ok(Error::FundingTargetReached))
    );
    f.client.contribute(&f.id, &a, &10);
    assert_eq!(f.client.get_escrow(&f.id).amount, 100);
    assert_eq!(
        f.client.try_contribute(&f.id, &a, &1),
        Err(Ok(Error::FundingTargetReached))
    );
    assert_eq!(record_of(&f, &a).unwrap().amount, 100);
    assert_eq!(f.token.balance(&f.contract_id), 100);

    // After a release there is nothing left to contribute to.
    f.client.release(&f.id, &f.releaser);
    assert_eq!(
        f.client.try_contribute(&f.id, &a, &1),
        Err(Ok(Error::NotFunded))
    );
}

#[test]
fn pooled_creation_validation() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(CREATED_AT);

    let token_id = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    let creator = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    let contract_id = env.register(EscrowContract, (Vec::<Address>::new(&env),));
    let client = EscrowContractClient::new(&env, &contract_id);
    let ref_str = String::from_str(&env, "pooled");

    // Non-positive targets.
    assert_eq!(
        client.try_create_pooled_escrow(
            &creator,
            &payee,
            &token_id,
            &0,
            &ref_str,
            &releaser,
            &(DEADLINE)
        ),
        Err(Ok(Error::InvalidAmount))
    );
    assert_eq!(
        client.try_create_pooled_escrow(
            &creator,
            &payee,
            &token_id,
            &-1,
            &ref_str,
            &releaser,
            &(DEADLINE)
        ),
        Err(Ok(Error::InvalidAmount))
    );
    // A deadline that is not strictly in the future.
    assert_eq!(
        client.try_create_pooled_escrow(
            &creator,
            &payee,
            &token_id,
            &100,
            &ref_str,
            &releaser,
            &CREATED_AT
        ),
        Err(Ok(Error::InvalidFundingDeadline))
    );
    assert_eq!(
        client.try_create_pooled_escrow(
            &creator,
            &payee,
            &token_id,
            &100,
            &ref_str,
            &releaser,
            &(CREATED_AT - 1)
        ),
        Err(Ok(Error::InvalidFundingDeadline))
    );
    // Oversized condition_ref.
    let long_ref = String::from_str(&env, &"x".repeat(65));
    assert_eq!(
        client.try_create_pooled_escrow(
            &creator, &payee, &token_id, &100, &long_ref, &releaser, &DEADLINE
        ),
        Err(Ok(Error::ConditionRefTooLong))
    );

    // A rejected creation locks nothing: no escrow exists, no id is
    // consumed, and a valid creation still works.
    assert!(client.try_get_status(&0).is_err());
    assert_eq!(
        client.create_pooled_escrow(
            &creator, &payee, &token_id, &100, &ref_str, &releaser, &DEADLINE
        ),
        0
    );
}

#[test]
fn pooled_creation_respects_the_token_allowlist() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(CREATED_AT);

    let allowed = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    let unlisted = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    let creator = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);

    let mut allowlist = Vec::new(&env);
    allowlist.push_back(allowed.clone());
    let contract_id = env.register(EscrowContract, (allowlist,));
    let client = EscrowContractClient::new(&env, &contract_id);

    assert_eq!(
        client.try_create_pooled_escrow(
            &creator,
            &payee,
            &unlisted,
            &100,
            &String::from_str(&env, "pooled"),
            &releaser,
            &DEADLINE
        ),
        Err(Ok(Error::DisallowedToken))
    );
    client.create_pooled_escrow(
        &creator,
        &payee,
        &allowed,
        &100,
        &String::from_str(&env, "pooled"),
        &releaser,
        &DEADLINE,
    );
}

// ---------------------------------------------------------------------------
// K — resource limits: unbounded contributors, O(1) claims
// ---------------------------------------------------------------------------

#[test]
fn no_contributor_cap_each_claim_is_independent() {
    // No entry point iterates contributors, so there is no contributor
    // cap to hit (ADR 0011 "Resource limits"): many contributors each
    // contribute and later claim with bounded, independent work.
    let env = Env::default();
    // Target above what the twelve contributors can reach: a failed round.
    let f = setup(&env, 130);
    let count = 12;
    let mut people: Vec<Address> = Vec::new(&env);
    for _ in 0..count {
        let person = contributor(&f, &env, 10);
        f.client.contribute(&f.id, &person, &10);
        people.push_back(person);
    }
    assert_eq!(f.client.get_escrow(&f.id).amount, 120);
    assert!(f.client.get_escrow(&f.id).amount < 130);

    advance_past_deadline(&env);
    for person in people.iter() {
        f.client.claim_refund(&f.id, &person);
        // Each claim pays exactly that contributor's record, once.
        assert_eq!(f.token.balance(&person), 10);
        assert!(record_of(&f, &person).unwrap().refunded);
    }
    assert_eq!(f.token.balance(&f.contract_id), 0);
}

// ---------------------------------------------------------------------------
// L — release safety: release and refund can never share funds
// ---------------------------------------------------------------------------

#[test]
fn release_with_approvals_is_gated_by_full_funding_too() {
    // The quorum entry point shares the pool's full-funding gate — a
    // single-releaser pooled escrow can also be settled through
    // `release_with_approvals([releaser])`, and it must fail the same way
    // while the pool is under target.
    let env = Env::default();
    let f = setup(&env, 50);
    let a = contributor(&f, &env, 50);
    f.client.contribute(&f.id, &a, &30);

    let approvers = vec![&env, f.releaser.clone()];
    assert_eq!(
        f.client.try_release_with_approvals(&f.id, &approvers),
        Err(Ok(Error::FundingIncomplete))
    );

    f.client.contribute(&f.id, &a, &20); // reach the target
    f.client.release_with_approvals(&f.id, &approvers);
    assert_eq!(f.client.get_status(&f.id), EscrowStatus::Released);
    assert_eq!(f.token.balance(&f.payee), 50);
}

#[test]
fn release_and_refund_can_never_share_funds() {
    // Order 1: fully funded, released — claims then fail NotFunded.
    let env = Env::default();
    let f = setup(&env, 50);
    let a = contributor(&f, &env, 50);
    f.client.contribute(&f.id, &a, &50);
    f.client.release(&f.id, &f.releaser);
    assert_eq!(f.token.balance(&f.payee), 50);
    assert_eq!(
        f.client.try_claim_refund(&f.id, &a),
        Err(Ok(Error::NotFunded))
    );
    assert_eq!(f.token.balance(&a), 0);

    // Order 2: failed round, claimed — release then fails forever, and a
    // second claim of the same contribution fails too.
    let f2 = setup(&env, 50);
    let b = contributor(&f2, &env, 30);
    f2.client.contribute(&f2.id, &b, &30); // 30 of 50 — round fails
    advance_past_deadline(&env);
    f2.client.claim_refund(&f2.id, &b);
    assert_eq!(f2.token.balance(&b), 30);
    assert_eq!(
        f2.client.try_release(&f2.id, &f2.releaser),
        Err(Ok(Error::FundingIncomplete))
    );
    assert_eq!(
        f2.client.try_claim_refund(&f2.id, &b),
        Err(Ok(Error::AlreadyRefunded))
    );
    // The payee never saw a token in either order.
    assert_eq!(f2.token.balance(&f2.payee), 0);
    assert_eq!(f2.token.balance(&f2.contract_id), 0);
}

// ---------------------------------------------------------------------------
// M — existing behaviour and blocked push paths
// ---------------------------------------------------------------------------

#[test]
fn push_paths_and_top_up_reject_pooled_escrows() {
    let env = Env::default();
    let f = setup(&env, 100);
    let a = contributor(&f, &env, 30);
    f.client.contribute(&f.id, &a, &30);

    // Push refunds would send the pooled total to one address, violating
    // per-contributor accounting — all of them are closed.
    assert_eq!(
        f.client.try_refund(&f.id, &f.releaser),
        Err(Ok(Error::NotSupportedForPooled))
    );
    let approvers = vec![&env, f.releaser.clone()];
    assert_eq!(
        f.client.try_refund_with_approvals(&f.id, &approvers),
        Err(Ok(Error::NotSupportedForPooled))
    );
    // `cancel` has no acceptance gate to race on a pooled escrow.
    assert_eq!(
        f.client.try_cancel(&f.id, &f.creator),
        Err(Ok(Error::NotSupportedForPooled))
    );
    // `top_up` would grow the aggregate without a contribution record.
    f.asset.mint(&f.creator, &50);
    assert_eq!(
        f.client.try_top_up(&f.id, &f.creator, &50),
        Err(Ok(Error::NotSupportedForPooled))
    );

    // Accounting untouched by every rejected path.
    assert_eq!(f.client.get_escrow(&f.id).amount, 30);
    assert_eq!(f.token.balance(&f.contract_id), 30);

    // `rotate_releaser` only changes who may release, never where funds
    // go — it stays available for pooled escrows (both signatures).
    let new_releaser = Address::generate(&env);
    f.client.rotate_releaser(&f.id, &f.releaser, &new_releaser);
    assert_eq!(
        f.client.try_release(&f.id, &f.releaser),
        Err(Ok(Error::Unauthorized))
    );
    // Contributing keeps working after the rotation — rotation changes
    // who releases, nothing about funding.
    f.asset.mint(&a, &5);
    f.client.contribute(&f.id, &a, &5);
    assert_eq!(f.client.get_escrow(&f.id).amount, 35);
}

#[test]
fn ordinary_escrows_are_unaffected() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(CREATED_AT);

    let token_id = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    let token = TokenClient::new(&env, &token_id);
    let asset = StellarAssetClient::new(&env, &token_id);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    asset.mint(&payer, &1_000);

    let contract_id = env.register(EscrowContract, (Vec::<Address>::new(&env),));
    let client = EscrowContractClient::new(&env, &contract_id);
    let id = client.create_escrow(
        &payer,
        &payee,
        &token_id,
        &300,
        &String::from_str(&env, "ordinary"),
        &releaser,
        &None,
        &false,
        &None,
        &None,
        &None,
    );

    // The pooled-only entry points refuse an ordinary escrow.
    assert_eq!(
        client.try_contribute(&id, &payer, &50),
        Err(Ok(Error::NotPooled))
    );
    assert_eq!(
        client.try_claim_refund(&id, &payer),
        Err(Ok(Error::NotPooled))
    );
    assert_eq!(client.try_get_pooled(&id), Err(Ok(Error::NotPooled)));
    assert_eq!(
        client.try_get_contribution(&id, &payer),
        Err(Ok(Error::NotPooled))
    );
    // ...and unknown ids keep their original error.
    assert_eq!(
        client.try_get_contribution(&99, &payer),
        Err(Ok(Error::NotFound))
    );

    // Single-payer behaviour itself is untouched: top_up, release, refund.
    client.top_up(&id, &payer, &100);
    assert_eq!(client.get_escrow(&id).amount, 400);
    client.release(&id, &releaser);
    assert_eq!(token.balance(&payee), 400);

    let id2 = client.create_escrow(
        &payer,
        &payee,
        &token_id,
        &100,
        &String::from_str(&env, "ordinary-2"),
        &releaser,
        &None,
        &false,
        &None,
        &None,
        &None,
    );
    client.refund(&id2, &releaser);
    assert_eq!(token.balance(&payer), 1_000 - 400 - 100 + 100);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[test]
fn contribute_emits_an_event() {
    let env = Env::default();
    let f = setup(&env, 100);
    let a = contributor(&f, &env, 30);

    f.client.contribute(&f.id, &a, &30);

    // Only this contract's events (the token's transfer event belongs to
    // a different contract); payload is (contributor, amount, new total).
    // Per issue #120 the committed snapshot of this test pins the same.
    assert_eq!(
        env.events().all().filter_by_contract(&f.contract_id),
        vec![
            &env,
            (
                f.contract_id.clone(),
                (symbol_short!("contrib"), f.id).into_val(&env),
                (a.clone(), 30i128, 30i128).into_val(&env),
            ),
        ]
    );
}

#[test]
fn claim_refund_emits_an_event() {
    let env = Env::default();
    let f = setup(&env, 100);
    let a = contributor(&f, &env, 30);
    f.client.contribute(&f.id, &a, &30);
    advance_past_deadline(&env);

    f.client.claim_refund(&f.id, &a);

    assert_eq!(
        env.events().all().filter_by_contract(&f.contract_id),
        vec![
            &env,
            (
                f.contract_id.clone(),
                (symbol_short!("claimed"), f.id).into_val(&env),
                (a.clone(), 30i128).into_val(&env),
            ),
        ]
    );
}
