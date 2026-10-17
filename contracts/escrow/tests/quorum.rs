// Phase E5 tests (issue #119) — in-contract M-of-N releaser quorum.
// Per AGENTS.md hard rule 2: payment logic changes need tests here in the
// same PR, not a follow-up.
//
// Design under test (docs/adr/0007): an escrow created with
// `create_escrow_with_releasers` stores a bounded releaser set plus a
// threshold. Settlement needs `threshold` *distinct* releasers, each of whom
// authorizes the same invocation; nothing is stored between calls, so there
// is no approval state to clear and no approval to replay. Single-releaser
// escrows keep their old behaviour (stored as a one-address set, threshold 1).

use docforum_escrow::{Error, EscrowContract, EscrowContractClient, EscrowStatus, MAX_RELEASERS};
use soroban_sdk::{
    testutils::{Address as _, Ledger as _, MockAuth, MockAuthInvoke},
    token::{StellarAssetClient, TokenClient},
    Address, Env, IntoVal, String, Vec,
};

const AMOUNT: i128 = 300;

struct Fixture<'a> {
    client: EscrowContractClient<'a>,
    token: TokenClient<'a>,
    contract_id: Address,
    payer: Address,
    payee: Address,
    releasers: Vec<Address>,
    escrow_id: u64,
}

fn releaser_set(env: &Env, count: usize) -> Vec<Address> {
    let mut set = Vec::new(env);
    for _ in 0..count {
        set.push_back(Address::generate(env));
    }
    set
}

/// Creates a quorum escrow with `count` releasers and the given threshold.
fn quorum_escrow(
    env: &Env,
    count: usize,
    threshold: u32,
    refund_after: Option<u64>,
) -> Fixture<'_> {
    env.mock_all_auths();

    let token_id = env
        .register_stellar_asset_contract_v2(Address::generate(env))
        .address();
    let token = TokenClient::new(env, &token_id);
    let asset = StellarAssetClient::new(env, &token_id);
    let payer = Address::generate(env);
    let payee = Address::generate(env);
    asset.mint(&payer, &1_000);

    let contract_id = env.register(EscrowContract, (Vec::<Address>::new(env),));
    let client = EscrowContractClient::new(env, &contract_id);

    let releasers = releaser_set(env, count);
    let escrow_id = client.create_escrow_with_releasers(
        &payer,
        &payee,
        &token_id,
        &AMOUNT,
        &String::from_str(env, "quorum-ref"),
        &releasers,
        &threshold,
        &refund_after,
        &false,
    );

    Fixture {
        client,
        token,
        contract_id,
        payer,
        payee,
        releasers,
        escrow_id,
    }
}

fn subset(env: &Env, set: &Vec<Address>, indexes: &[u32]) -> Vec<Address> {
    let mut out = Vec::new(env);
    for index in indexes {
        out.push_back(set.get(*index).unwrap());
    }
    out
}

// --- creation: what is stored, and which sets are rejected ---

#[test]
fn quorum_escrow_stores_the_releaser_set_and_threshold() {
    let env = Env::default();
    let f = quorum_escrow(&env, 3, 2, None);

    let data = f.client.get_escrow(&f.escrow_id);

    assert_eq!(data.status, EscrowStatus::Funded);
    assert_eq!(data.threshold, 2);
    assert_eq!(data.releasers.len(), 3);
    assert_eq!(data.releasers.get(0).unwrap(), f.releasers.get(0).unwrap());
    assert_eq!(data.releasers.get(2).unwrap(), f.releasers.get(2).unwrap());
}

#[test]
fn create_rejects_an_empty_releaser_set() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, token_id, payer) = empty_fixture(&env);

    let result = client.try_create_escrow_with_releasers(
        &payer,
        &Address::generate(&env),
        &token_id,
        &AMOUNT,
        &String::from_str(&env, "quorum-ref"),
        &Vec::<Address>::new(&env),
        &1,
        &None,
        &false,
    );

    assert_eq!(result, Err(Ok(Error::InvalidThreshold)));
}

#[test]
fn create_rejects_zero_threshold_and_threshold_above_set_size() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, token_id, payer) = empty_fixture(&env);
    let releasers = releaser_set(&env, 2);

    for threshold in [0, 3] {
        let result = client.try_create_escrow_with_releasers(
            &payer,
            &Address::generate(&env),
            &token_id,
            &AMOUNT,
            &String::from_str(&env, "quorum-ref"),
            &releasers,
            &threshold,
            &None,
            &false,
        );
        assert_eq!(result, Err(Ok(Error::InvalidThreshold)));
    }
}

#[test]
fn create_rejects_duplicate_releasers() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, token_id, payer) = empty_fixture(&env);
    let duplicate = Address::generate(&env);
    let mut releasers = Vec::new(&env);
    releasers.push_back(duplicate.clone());
    releasers.push_back(duplicate);

    let result = client.try_create_escrow_with_releasers(
        &payer,
        &Address::generate(&env),
        &token_id,
        &AMOUNT,
        &String::from_str(&env, "quorum-ref"),
        &releasers,
        &2,
        &None,
        &false,
    );

    assert_eq!(result, Err(Ok(Error::DuplicateReleaser)));
}

#[test]
fn create_bounds_the_releaser_set_size() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, token_id, payer) = empty_fixture(&env);

    let too_many = releaser_set(&env, (MAX_RELEASERS + 1) as usize);
    let result = client.try_create_escrow_with_releasers(
        &payer,
        &Address::generate(&env),
        &token_id,
        &AMOUNT,
        &String::from_str(&env, "quorum-ref"),
        &too_many,
        &1,
        &None,
        &false,
    );
    assert_eq!(result, Err(Ok(Error::TooManyReleasers)));

    // Exactly MAX_RELEASERS is fine.
    let at_limit = releaser_set(&env, MAX_RELEASERS as usize);
    let created = client.try_create_escrow_with_releasers(
        &payer,
        &Address::generate(&env),
        &token_id,
        &AMOUNT,
        &String::from_str(&env, "quorum-ref"),
        &at_limit,
        &1,
        &None,
        &false,
    );
    assert!(created.is_ok());
}

#[test]
fn rejected_quorum_creation_locks_nothing() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, token_id, payer) = empty_fixture(&env);

    assert!(client
        .try_create_escrow_with_releasers(
            &payer,
            &Address::generate(&env),
            &token_id,
            &AMOUNT,
            &String::from_str(&env, "quorum-ref"),
            &releaser_set(&env, 2),
            &3,
            &None,
            &false,
        )
        .is_err());

    let token = TokenClient::new(&env, &token_id);
    assert_eq!(token.balance(&payer), 1_000);
}

// --- release with approvals ---

#[test]
fn release_with_exactly_threshold_distinct_approvals_pays_the_payee() {
    let env = Env::default();
    let f = quorum_escrow(&env, 3, 2, None);

    // Order does not matter, and the remaining releaser does not approve.
    let approvers = subset(&env, &f.releasers, &[2, 0]);
    f.client.release_with_approvals(&f.escrow_id, &approvers);

    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Released);
    assert_eq!(f.token.balance(&f.payee), AMOUNT);
}

#[test]
fn release_with_more_than_threshold_approvals_succeeds() {
    let env = Env::default();
    let f = quorum_escrow(&env, 3, 2, None);

    let approvers = subset(&env, &f.releasers, &[0, 1, 2]);
    f.client.release_with_approvals(&f.escrow_id, &approvers);

    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Released);
}

#[test]
fn release_with_fewer_than_threshold_approvals_is_rejected() {
    let env = Env::default();
    let f = quorum_escrow(&env, 3, 2, None);

    let approvers = subset(&env, &f.releasers, &[0]);
    let result = f
        .client
        .try_release_with_approvals(&f.escrow_id, &approvers);

    assert_eq!(result, Err(Ok(Error::ThresholdNotMet)));
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Funded);
    assert_eq!(f.token.balance(&f.payee), 0);
}

#[test]
fn duplicate_approvals_from_one_releaser_cannot_satisfy_the_threshold() {
    let env = Env::default();
    let f = quorum_escrow(&env, 3, 2, None);

    // The reviewer's key check: one releaser listed twice is still one
    // approval, never two.
    let mut approvers = Vec::new(&env);
    let repeated = f.releasers.get(0).unwrap();
    approvers.push_back(repeated.clone());
    approvers.push_back(repeated);
    let result = f
        .client
        .try_release_with_approvals(&f.escrow_id, &approvers);

    assert_eq!(result, Err(Ok(Error::DuplicateApprover)));
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Funded);
    assert_eq!(f.token.balance(&f.payee), 0);
}

#[test]
fn non_member_approver_is_rejected() {
    let env = Env::default();
    let f = quorum_escrow(&env, 3, 2, None);
    let stranger = Address::generate(&env);

    let mut approvers = subset(&env, &f.releasers, &[0]);
    approvers.push_back(stranger);
    let result = f
        .client
        .try_release_with_approvals(&f.escrow_id, &approvers);

    assert_eq!(result, Err(Ok(Error::Unauthorized)));
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Funded);
}

#[test]
fn single_caller_release_on_a_quorum_escrow_needs_the_approval_path() {
    let env = Env::default();
    let f = quorum_escrow(&env, 3, 2, None);
    let member = f.releasers.get(0).unwrap();

    let result = f.client.try_release(&f.escrow_id, &member);

    // A member is not "unauthorized" — they just cannot settle alone.
    assert_eq!(result, Err(Ok(Error::ThresholdNotMet)));
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Funded);
}

#[test]
fn each_listed_approver_must_actually_authorize_the_invocation() {
    let env = Env::default();
    let f = quorum_escrow(&env, 3, 2, None);
    let approvers = subset(&env, &f.releasers, &[0, 1]);
    let first = approvers.get(0).unwrap();
    let second = approvers.get(1).unwrap();
    let args = (f.escrow_id, approvers.clone()).into_val(&env);
    let invoke = MockAuthInvoke {
        contract: &f.contract_id,
        fn_name: "release_with_approvals",
        args,
        sub_invokes: &[],
    };

    // Only the first approver's auth is mocked: listing the second address
    // is not a signature, and an approval is bound to this exact invocation.
    env.mock_auths(&[MockAuth {
        address: &first,
        invoke: &invoke,
    }]);
    assert!(f
        .client
        .try_release_with_approvals(&f.escrow_id, &approvers)
        .is_err());
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Funded);
    assert_eq!(f.token.balance(&f.payee), 0);

    // With both approvers authorizing the same call, it settles.
    env.mock_auths(&[
        MockAuth {
            address: &first,
            invoke: &invoke,
        },
        MockAuth {
            address: &second,
            invoke: &invoke,
        },
    ]);
    f.client.release_with_approvals(&f.escrow_id, &approvers);
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Released);
}

#[test]
fn settled_approvals_cannot_be_replayed() {
    let env = Env::default();
    let f = quorum_escrow(&env, 3, 2, None);
    let approvers = subset(&env, &f.releasers, &[0, 1]);

    f.client.release_with_approvals(&f.escrow_id, &approvers);
    let replay = f
        .client
        .try_release_with_approvals(&f.escrow_id, &approvers);

    assert_eq!(replay, Err(Ok(Error::NotFunded)));
    assert_eq!(f.token.balance(&f.payee), AMOUNT); // paid once, not twice
}

// --- refund with approvals, and the untouched timeout path ---

#[test]
fn refund_with_approvals_returns_funds_to_the_payer() {
    let env = Env::default();
    let f = quorum_escrow(&env, 3, 2, None);
    let approvers = subset(&env, &f.releasers, &[1, 2]);

    f.client.refund_with_approvals(&f.escrow_id, &approvers);

    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Refunded);
    assert_eq!(f.token.balance(&f.payer), 1_000);
    assert_eq!(f.token.balance(&f.payee), 0);
}

#[test]
fn refund_with_approvals_rejects_duplicates_and_short_thresholds() {
    let env = Env::default();
    let f = quorum_escrow(&env, 3, 2, None);

    let short = subset(&env, &f.releasers, &[0]);
    assert_eq!(
        f.client.try_refund_with_approvals(&f.escrow_id, &short),
        Err(Ok(Error::ThresholdNotMet))
    );

    let repeated = f.releasers.get(0).unwrap();
    let mut duplicates = Vec::new(&env);
    duplicates.push_back(repeated.clone());
    duplicates.push_back(repeated);
    assert_eq!(
        f.client
            .try_refund_with_approvals(&f.escrow_id, &duplicates),
        Err(Ok(Error::DuplicateApprover))
    );
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Funded);
}

#[test]
fn timeout_refund_still_needs_no_approvals_on_a_quorum_escrow() {
    let env = Env::default();
    let deadline = 1_100;
    env.ledger().set_timestamp(1_000);
    let f = quorum_escrow(&env, 3, 2, Some(deadline));
    let stranger = Address::generate(&env);

    env.ledger().set_timestamp(deadline);
    f.client.refund(&f.escrow_id, &stranger);

    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Refunded);
    assert_eq!(f.token.balance(&f.payer), 1_000);
    assert_eq!(f.token.balance(&stranger), 0);
}

#[test]
fn releasers_can_still_release_after_the_deadline() {
    let env = Env::default();
    let deadline = 1_100;
    env.ledger().set_timestamp(1_000);
    let f = quorum_escrow(&env, 3, 2, Some(deadline));
    let approvers = subset(&env, &f.releasers, &[0, 2]);

    env.ledger().set_timestamp(deadline + 1);
    f.client.release_with_approvals(&f.escrow_id, &approvers);

    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Released);
}

// --- single-releaser escrows are unchanged ---

#[test]
fn single_releaser_escrow_behaves_as_a_one_of_one_quorum() {
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
    asset.mint(&payer, &1_000);

    let contract_id = env.register(EscrowContract, (Vec::<Address>::new(&env),));
    let client = EscrowContractClient::new(&env, &contract_id);

    let first = client.create_escrow(
        &payer,
        &payee,
        &token_id,
        &AMOUNT,
        &String::from_str(&env, "single-a"),
        &releaser,
        &None,
    );
    let data = client.get_escrow(&first);
    assert_eq!(data.threshold, 1);
    assert_eq!(data.releasers.len(), 1);
    assert_eq!(data.releasers.get(0).unwrap(), releaser);

    // Old entry point, unchanged.
    client.release(&first, &releaser);
    assert_eq!(token.balance(&payee), AMOUNT);

    // The approvals entry point also accepts the one releaser.
    let second = client.create_escrow(
        &payer,
        &payee,
        &token_id,
        &AMOUNT,
        &String::from_str(&env, "single-b"),
        &releaser,
        &None,
    );
    let mut approvers = Vec::new(&env);
    approvers.push_back(releaser.clone());
    client.release_with_approvals(&second, &approvers);
    assert_eq!(token.balance(&payee), AMOUNT * 2);
}

fn empty_fixture<'a>(env: &'a Env) -> (EscrowContractClient<'a>, Address, Address) {
    let token_id = env
        .register_stellar_asset_contract_v2(Address::generate(env))
        .address();
    let asset = StellarAssetClient::new(env, &token_id);
    let payer = Address::generate(env);
    asset.mint(&payer, &1_000);
    let contract_id = env.register(EscrowContract, (Vec::<Address>::new(env),));
    let client = EscrowContractClient::new(env, &contract_id);
    (client, token_id, payer)
}
