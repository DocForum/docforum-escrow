// Phase E6 tests — disputes, arbitration and split settlement (issue #73).
// Per AGENTS.md hard rule 2: money-moving logic needs contract tests here
// before merge.
//
// Lifecycle under test:
//   Funded --raise_dispute--> Disputed --resolve_dispute--> Disputed (with a
//   recorded split) --settle--> Released, paying payer and payee their shares.
//
// Invariants these tests pin down:
//   * only payer/payee/releasers may raise a dispute, and only while Funded;
//   * a Disputed escrow can no longer be released or refunded directly, so an
//     in-flight adjudication cannot be raced by a settlement;
//   * only the stored arbiter may record a split, only once, and the basis
//     points must sum to 10_000;
//   * settle is permissionless, deterministic and leaves no dust behind.

use docforum_escrow::{Error, EscrowContract, EscrowContractClient, EscrowStatus};
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    Address, Env, String, Vec,
};

struct Fixture<'a> {
    client: EscrowContractClient<'a>,
    token: TokenClient<'a>,
    contract_id: Address,
    payer: Address,
    payee: Address,
    releaser: Address,
    arbiter: Address,
    id: u64,
}

/// Registers the contract and a token, then creates a Funded escrow with an
/// arbiter — the pre-E6 entry points are covered separately below.
fn funded_escrow_with_arbiter(env: &Env, amount: i128) -> Fixture<'_> {
    env.mock_all_auths();

    let token_id = env
        .register_stellar_asset_contract_v2(Address::generate(env))
        .address();
    let token = TokenClient::new(env, &token_id);
    let asset = StellarAssetClient::new(env, &token_id);
    let payer = Address::generate(env);
    let payee = Address::generate(env);
    let releaser = Address::generate(env);
    let arbiter = Address::generate(env);
    // Mint exactly `amount`: the payer's post-settlement balance is then
    // precisely the share the split returned to them.
    asset.mint(&payer, &amount);

    let contract_id = env.register(EscrowContract, (Vec::<Address>::new(env),));
    let client = EscrowContractClient::new(env, &contract_id);
    let id = client.create_escrow_with_arbiter(
        &payer,
        &payee,
        &token_id,
        &amount,
        &String::from_str(env, "dispute-condition-ref"),
        &releaser,
        &None,
        &arbiter,
        &false,
        &None,
        &None,
    );

    Fixture {
        client,
        token,
        contract_id,
        payer,
        payee,
        releaser,
        arbiter,
        id,
    }
}

fn raise_and_resolve(f: &Fixture<'_>, payer_bps: u32, payee_bps: u32) {
    f.client.raise_dispute(&f.id, &f.payer);
    f.client
        .resolve_dispute(&f.id, &f.arbiter, &payer_bps, &payee_bps);
}

// --- creation ---

#[test]
fn create_with_arbiter_records_it_and_funds_the_escrow() {
    let env = Env::default();
    let f = funded_escrow_with_arbiter(&env, 300);

    let dispute = f.client.get_dispute(&f.id);
    assert_eq!(dispute.arbiter, Some(f.arbiter.clone()));
    assert!(!dispute.resolved);
    assert_eq!(dispute.payer_bps, 0);
    assert_eq!(dispute.payee_bps, 0);

    assert_eq!(f.client.get_status(&f.id), EscrowStatus::Funded);
    assert_eq!(f.token.balance(&f.contract_id), 300);
    assert_eq!(f.token.balance(&f.payer), 0);
}

#[test]
fn escrow_created_without_arbiter_has_no_arbiter() {
    let env = Env::default();
    env.mock_all_auths();
    let token_id = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    let asset = StellarAssetClient::new(&env, &token_id);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    asset.mint(&payer, &500);
    let contract_id = env.register(EscrowContract, (Vec::<Address>::new(&env),));
    let client = EscrowContractClient::new(&env, &contract_id);
    let id = client.create_escrow(
        &payer,
        &payee,
        &token_id,
        &300,
        &String::from_str(&env, "legacy-escrow"),
        &releaser,
        &None,
        &false,
        &None,
    );

    let dispute = client.get_dispute(&id);
    assert_eq!(dispute.arbiter, None);
    assert!(!dispute.resolved);
}

// --- raise_dispute ---

#[test]
fn payer_can_raise_a_dispute() {
    let env = Env::default();
    let f = funded_escrow_with_arbiter(&env, 300);

    f.client.raise_dispute(&f.id, &f.payer);

    assert_eq!(f.client.get_status(&f.id), EscrowStatus::Disputed);
    // Raising a dispute moves no money.
    assert_eq!(f.token.balance(&f.contract_id), 300);
}

#[test]
fn payee_can_raise_a_dispute() {
    let env = Env::default();
    let f = funded_escrow_with_arbiter(&env, 300);

    f.client.raise_dispute(&f.id, &f.payee);

    assert_eq!(f.client.get_status(&f.id), EscrowStatus::Disputed);
}

#[test]
fn releaser_can_raise_a_dispute() {
    let env = Env::default();
    let f = funded_escrow_with_arbiter(&env, 300);

    f.client.raise_dispute(&f.id, &f.releaser);

    assert_eq!(f.client.get_status(&f.id), EscrowStatus::Disputed);
}

#[test]
fn stranger_cannot_raise_a_dispute() {
    let env = Env::default();
    let f = funded_escrow_with_arbiter(&env, 300);
    let stranger = Address::generate(&env);

    let result = f.client.try_raise_dispute(&f.id, &stranger);

    assert!(matches!(result, Err(Ok(Error::Unauthorized))));
    assert_eq!(f.client.get_status(&f.id), EscrowStatus::Funded);
}

#[test]
fn cannot_raise_a_dispute_on_a_settled_escrow() {
    let env = Env::default();
    let f = funded_escrow_with_arbiter(&env, 300);
    f.client.release(&f.id, &f.releaser);

    let result = f.client.try_raise_dispute(&f.id, &f.payer);

    assert!(matches!(result, Err(Ok(Error::NotFunded))));
    assert_eq!(f.client.get_status(&f.id), EscrowStatus::Released);
}

#[test]
fn cannot_raise_a_dispute_twice() {
    let env = Env::default();
    let f = funded_escrow_with_arbiter(&env, 300);
    f.client.raise_dispute(&f.id, &f.payer);

    let again = f.client.try_raise_dispute(&f.id, &f.payee);

    assert!(matches!(again, Err(Ok(Error::NotFunded))));
    assert_eq!(f.client.get_status(&f.id), EscrowStatus::Disputed);
}

// --- release/refund are frozen while disputed ---

#[test]
fn disputed_escrow_cannot_be_released_or_refunded() {
    let env = Env::default();
    let f = funded_escrow_with_arbiter(&env, 300);
    f.client.raise_dispute(&f.id, &f.payer);

    let release = f.client.try_release(&f.id, &f.releaser);
    let refund = f.client.try_refund(&f.id, &f.releaser);

    assert!(matches!(release, Err(Ok(Error::NotFunded))));
    assert!(matches!(refund, Err(Ok(Error::NotFunded))));
    assert_eq!(f.client.get_status(&f.id), EscrowStatus::Disputed);
    assert_eq!(f.token.balance(&f.contract_id), 300);
}

#[test]
fn dispute_also_freezes_the_quorum_approval_paths() {
    let env = Env::default();
    env.mock_all_auths();
    let token_id = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    let asset = StellarAssetClient::new(&env, &token_id);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let first = Address::generate(&env);
    let second = Address::generate(&env);
    asset.mint(&payer, &500);
    let contract_id = env.register(EscrowContract, (Vec::<Address>::new(&env),));
    let client = EscrowContractClient::new(&env, &contract_id);
    let mut releasers = Vec::new(&env);
    releasers.push_back(first.clone());
    releasers.push_back(second.clone());
    let id = client.create_escrow_with_releasers(
        &payer,
        &payee,
        &token_id,
        &300,
        &String::from_str(&env, "quorum-dispute"),
        &releasers,
        &1,
        &None,
        &false,
        &None,
    );
    client.raise_dispute(&id, &second);

    let mut approvers = Vec::new(&env);
    approvers.push_back(first);
    let release = client.try_release_with_approvals(&id, &approvers);

    assert!(matches!(release, Err(Ok(Error::NotFunded))));
    assert_eq!(client.get_status(&id), EscrowStatus::Disputed);
}

// --- resolve_dispute ---

#[test]
fn only_the_arbiter_can_resolve() {
    let env = Env::default();
    let f = funded_escrow_with_arbiter(&env, 300);
    f.client.raise_dispute(&f.id, &f.payer);

    let by_payer = f
        .client
        .try_resolve_dispute(&f.id, &f.payer, &5_000, &5_000);
    let by_payee = f
        .client
        .try_resolve_dispute(&f.id, &f.payee, &5_000, &5_000);
    let by_releaser = f
        .client
        .try_resolve_dispute(&f.id, &f.releaser, &5_000, &5_000);

    assert!(matches!(by_payer, Err(Ok(Error::Unauthorized))));
    assert!(matches!(by_payee, Err(Ok(Error::Unauthorized))));
    assert!(matches!(by_releaser, Err(Ok(Error::Unauthorized))));
    assert!(!f.client.get_dispute(&f.id).resolved);
}

#[test]
fn cannot_resolve_an_escrow_that_is_not_disputed() {
    let env = Env::default();
    let f = funded_escrow_with_arbiter(&env, 300);

    let result = f
        .client
        .try_resolve_dispute(&f.id, &f.arbiter, &5_000, &5_000);

    assert!(matches!(result, Err(Ok(Error::NotDisputed))));
}

#[test]
fn split_must_sum_to_ten_thousand() {
    let env = Env::default();
    let f = funded_escrow_with_arbiter(&env, 300);
    f.client.raise_dispute(&f.id, &f.payer);

    let too_low = f
        .client
        .try_resolve_dispute(&f.id, &f.arbiter, &6_000, &3_999);
    let too_high = f
        .client
        .try_resolve_dispute(&f.id, &f.arbiter, &6_000, &4_001);

    assert!(matches!(too_low, Err(Ok(Error::InvalidSplit))));
    assert!(matches!(too_high, Err(Ok(Error::InvalidSplit))));
    assert!(!f.client.get_dispute(&f.id).resolved);
}

#[test]
fn resolving_records_the_split_without_moving_funds() {
    let env = Env::default();
    let f = funded_escrow_with_arbiter(&env, 300);
    f.client.raise_dispute(&f.id, &f.payer);

    f.client.resolve_dispute(&f.id, &f.arbiter, &4_000, &6_000);

    let dispute = f.client.get_dispute(&f.id);
    assert!(dispute.resolved);
    assert_eq!(dispute.payer_bps, 4_000);
    assert_eq!(dispute.payee_bps, 6_000);
    assert_eq!(f.client.get_status(&f.id), EscrowStatus::Disputed);
    assert_eq!(f.token.balance(&f.contract_id), 300);
}

#[test]
fn a_resolution_cannot_be_rewritten() {
    let env = Env::default();
    let f = funded_escrow_with_arbiter(&env, 300);
    raise_and_resolve(&f, 4_000, 6_000);

    let second = f
        .client
        .try_resolve_dispute(&f.id, &f.arbiter, &9_000, &1_000);

    assert!(matches!(second, Err(Ok(Error::AlreadyResolved))));
    let dispute = f.client.get_dispute(&f.id);
    assert_eq!(dispute.payer_bps, 4_000);
    assert_eq!(dispute.payee_bps, 6_000);
}

#[test]
fn an_escrow_without_an_arbiter_cannot_be_resolved() {
    let env = Env::default();
    env.mock_all_auths();
    let token_id = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    let asset = StellarAssetClient::new(&env, &token_id);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    asset.mint(&payer, &500);
    let contract_id = env.register(EscrowContract, (Vec::<Address>::new(&env),));
    let client = EscrowContractClient::new(&env, &contract_id);
    let id = client.create_escrow(
        &payer,
        &payee,
        &token_id,
        &300,
        &String::from_str(&env, "no-arbiter"),
        &releaser,
        &None,
        &false,
        &None,
    );
    client.raise_dispute(&id, &payer);

    // Nobody is the arbiter, so nobody can record a split.
    let attempt = client.try_resolve_dispute(&id, &payer, &5_000, &5_000);

    assert!(matches!(attempt, Err(Ok(Error::Unauthorized))));
}

// --- settle ---

#[test]
fn settle_before_a_resolution_fails() {
    let env = Env::default();
    let f = funded_escrow_with_arbiter(&env, 300);
    f.client.raise_dispute(&f.id, &f.payer);

    let result = f.client.try_settle(&f.id);

    assert!(matches!(result, Err(Ok(Error::NotResolved))));
    assert_eq!(f.token.balance(&f.contract_id), 300);
}

#[test]
fn settle_on_a_funded_escrow_fails() {
    let env = Env::default();
    let f = funded_escrow_with_arbiter(&env, 300);

    let result = f.client.try_settle(&f.id);

    assert!(matches!(result, Err(Ok(Error::NotDisputed))));
}

#[test]
fn settle_pays_both_sides_according_to_the_split() {
    let env = Env::default();
    let f = funded_escrow_with_arbiter(&env, 1_000);
    raise_and_resolve(&f, 4_000, 6_000);

    f.client.settle(&f.id);

    assert_eq!(f.token.balance(&f.payer), 400);
    assert_eq!(f.token.balance(&f.payee), 600);
    assert_eq!(f.token.balance(&f.contract_id), 0);
    assert_eq!(f.client.get_status(&f.id), EscrowStatus::Released);
}

#[test]
fn settle_is_permissionless() {
    let env = Env::default();
    let f = funded_escrow_with_arbiter(&env, 1_000);
    raise_and_resolve(&f, 5_000, 5_000);

    // No caller address and no auth entry: any account can submit the
    // deterministic payout once the arbiter has recorded the split.
    f.client.settle(&f.id);

    assert_eq!(f.token.balance(&f.payer), 500);
    assert_eq!(f.token.balance(&f.payee), 500);
}

#[test]
fn a_full_refund_split_pays_only_the_payer() {
    let env = Env::default();
    let f = funded_escrow_with_arbiter(&env, 1_000);
    raise_and_resolve(&f, 10_000, 0);

    f.client.settle(&f.id);

    assert_eq!(f.token.balance(&f.payer), 1_000);
    assert_eq!(f.token.balance(&f.payee), 0);
    assert_eq!(f.token.balance(&f.contract_id), 0);
}

#[test]
fn a_full_release_split_pays_only_the_payee() {
    let env = Env::default();
    let f = funded_escrow_with_arbiter(&env, 1_000);
    raise_and_resolve(&f, 0, 10_000);

    f.client.settle(&f.id);

    assert_eq!(f.token.balance(&f.payer), 0);
    assert_eq!(f.token.balance(&f.payee), 1_000);
    assert_eq!(f.token.balance(&f.contract_id), 0);
}

#[test]
fn settle_rounds_in_the_payers_favour_but_leaves_no_dust() {
    let env = Env::default();
    let f = funded_escrow_with_arbiter(&env, 1_001);
    raise_and_resolve(&f, 3_333, 6_667);

    f.client.settle(&f.id);

    // 1_001 * 3_333 / 10_000 = 333 (truncated); the payee receives the
    // remaining 668 so the whole amount leaves the contract.
    assert_eq!(f.token.balance(&f.payer), 333);
    assert_eq!(f.token.balance(&f.payee), 668);
    assert_eq!(f.token.balance(&f.contract_id), 0);
}

#[test]
fn settle_cannot_run_twice() {
    let env = Env::default();
    let f = funded_escrow_with_arbiter(&env, 1_000);
    raise_and_resolve(&f, 5_000, 5_000);
    f.client.settle(&f.id);

    let again = f.client.try_settle(&f.id);

    assert!(matches!(again, Err(Ok(Error::NotDisputed))));
    assert_eq!(f.token.balance(&f.contract_id), 0);
    assert_eq!(f.client.get_status(&f.id), EscrowStatus::Released);
}

#[test]
fn get_dispute_errors_for_an_unknown_escrow() {
    let env = Env::default();
    let f = funded_escrow_with_arbiter(&env, 300);

    let result = f.client.try_get_dispute(&99);

    assert!(matches!(result, Err(Ok(Error::NotFound))));
}

// --- creation parity with plain escrows ------------------------------------
//
// `create_escrow_with_arbiter` accepts the same optional `refund_to` and
// `release_not_before` as the non-arbiter entry points. Without these tests a
// future signature change could silently drop a sponsored refund destination
// or release schedule simply because the escrow has an arbiter.

#[test]
fn arbiter_escrow_keeps_the_sponsored_refund_destination() {
    let env = Env::default();
    env.mock_all_auths();

    let token_id = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    let token = TokenClient::new(&env, &token_id);
    let asset = StellarAssetClient::new(&env, &token_id);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    let arbiter = Address::generate(&env);
    let sponsor = Address::generate(&env);
    asset.mint(&payer, &400);

    let contract_id = env.register(EscrowContract, (Vec::<Address>::new(&env),));
    let client = EscrowContractClient::new(&env, &contract_id);
    let id = client.create_escrow_with_arbiter(
        &payer,
        &payee,
        &token_id,
        &400,
        &String::from_str(&env, "sponsored-arbiter"),
        &releaser,
        &None,
        &arbiter,
        &false,
        &Some(sponsor.clone()),
        &None,
    );

    assert_eq!(client.get_escrow(&id).refund_to, sponsor);
    client.refund(&id, &releaser);
    assert_eq!(token.balance(&sponsor), 400);
    assert_eq!(token.balance(&payer), 0);
    assert_eq!(token.balance(&contract_id), 0);
}

#[test]
fn arbiter_escrow_can_set_a_release_time() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let token_id = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    let token = TokenClient::new(&env, &token_id);
    let asset = StellarAssetClient::new(&env, &token_id);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    let arbiter = Address::generate(&env);
    asset.mint(&payer, &300);

    let release_at = 1_500;
    let contract_id = env.register(EscrowContract, (Vec::<Address>::new(&env),));
    let client = EscrowContractClient::new(&env, &contract_id);
    let id = client.create_escrow_with_arbiter(
        &payer,
        &payee,
        &token_id,
        &300,
        &String::from_str(&env, "scheduled-arbiter"),
        &releaser,
        &None,
        &arbiter,
        &false,
        &None,
        &Some(release_at),
    );

    assert_eq!(client.get_escrow(&id).release_not_before, Some(release_at));
    assert_eq!(
        client.try_release(&id, &releaser),
        Err(Ok(Error::ReleaseTooEarly))
    );

    env.ledger().set_timestamp(release_at);
    client.release(&id, &releaser);
    assert_eq!(token.balance(&payee), 300);
    assert_eq!(token.balance(&contract_id), 0);
}
