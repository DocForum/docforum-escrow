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

    let contract_id = env.register(
        EscrowContract,
        (Vec::<Address>::new(env), Address::generate(env)),
    );
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
    assert_eq!(
        f.client.try_claim_refund(&f.id, &a),
        Err(Ok(Error::AlreadyRefunded))
    );
    // The second attempt moved no money.
    assert_eq!(f.token.balance(&a), 30);
    assert_eq!(f.token.balance(&f.contract_id), 0);
}
