use docforum_escrow::{
    Error, EscrowContract, EscrowContractClient, EscrowStatus, SettleAction, MAX_MILESTONES,
};
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
    escrow_id: u64,
}

fn fixture<const N: usize>(
    env: &Env,
    milestones: [i128; N],
    refund_after: Option<u64>,
) -> Fixture<'_> {
    env.mock_all_auths();
    let admin = Address::generate(env);
    let token_id = env.register_stellar_asset_contract_v2(admin).address();
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
    let schedule = Vec::from_array(env, milestones);
    let escrow_id = client.create_escrow_with_milestones(
        &payer,
        &payee,
        &token_id,
        &1_000,
        &String::from_str(env, "milestone-test"),
        &releaser,
        &schedule,
        &refund_after,
        &false,
        &None,
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
        escrow_id,
    }
}

#[test]
fn creation_stores_immutable_schedule_and_funded_status() {
    let env = Env::default();
    let f = fixture(&env, [200, 300, 500], None);

    let data = f.client.get_milestones(&f.escrow_id);
    assert_eq!(data.amounts, Vec::from_array(&env, [200, 300, 500]));
    assert_eq!(data.released, Vec::from_array(&env, [false, false, false]));
    assert_eq!(data.paid, 0);
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Funded);
    assert_eq!(f.token.balance(&f.contract_id), 1_000);
}

#[test]
fn invalid_schedule_does_not_lock_funds() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(admin).address();
    let token = TokenClient::new(&env, &token_id);
    let asset = StellarAssetClient::new(&env, &token_id);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    asset.mint(&payer, &1_000);
    let contract_id = env.register(
        EscrowContract,
        (Vec::<Address>::new(&env), Address::generate(&env)),
    );
    let client = EscrowContractClient::new(&env, &contract_id);

    for schedule in [
        Vec::<i128>::new(&env),
        Vec::from_array(&env, [0, 1_000]),
        Vec::from_array(&env, [600, 399]),
    ] {
        let result = client.try_create_escrow_with_milestones(
            &payer,
            &payee,
            &token_id,
            &1_000,
            &String::from_str(&env, "invalid-milestones"),
            &releaser,
            &schedule,
            &None,
            &false,
            &None,
            &None,
            &None,
        );
        assert_eq!(result, Err(Ok(Error::InvalidMilestones)));
    }
    let mut too_many = Vec::new(&env);
    for _ in 0..=MAX_MILESTONES {
        too_many.push_back(1);
    }
    assert_eq!(
        client.try_create_escrow_with_milestones(
            &payer,
            &payee,
            &token_id,
            &1_000,
            &String::from_str(&env, "too-many-milestones"),
            &releaser,
            &too_many,
            &None,
            &false,
            &None,
            &None,
            &None,
        ),
        Err(Ok(Error::TooManyMilestones))
    );
    assert_eq!(
        client.try_create_escrow_with_milestones(
            &payer,
            &payee,
            &token_id,
            &i128::MAX,
            &String::from_str(&env, "overflowing-milestones"),
            &releaser,
            &Vec::from_array(&env, [i128::MAX, 1]),
            &None,
            &false,
            &None,
            &None,
            &None,
        ),
        Err(Ok(Error::Overflow))
    );
    assert_eq!(token.balance(&payer), 1_000);
    assert_eq!(token.balance(&contract_id), 0);
    assert!(matches!(
        client.try_get_status(&0),
        Err(Ok(Error::NotFound))
    ));
}

#[test]
fn releases_are_out_of_order_and_final_release_settles() {
    let env = Env::default();
    let f = fixture(&env, [200, 300, 500], None);

    f.client.release_milestone(&f.escrow_id, &1, &f.releaser);
    f.client.release_milestone(&f.escrow_id, &0, &f.releaser);
    let partial = f.client.get_milestones(&f.escrow_id);
    assert_eq!(partial.paid, 500);
    assert_eq!(partial.released, Vec::from_array(&env, [true, true, false]));
    assert_eq!(f.token.balance(&f.payee), 500);
    assert_eq!(f.token.balance(&f.contract_id), 500);
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Funded);

    f.client.release_milestone(&f.escrow_id, &2, &f.releaser);
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Released);
    assert_eq!(f.client.get_milestones(&f.escrow_id).paid, 1_000);
    assert_eq!(f.token.balance(&f.payee), 1_000);
    assert_eq!(f.token.balance(&f.contract_id), 0);
}

#[test]
fn every_tranche_order_releases_the_full_amount_exactly_once() {
    let orders = [
        [0, 1, 2],
        [0, 2, 1],
        [1, 0, 2],
        [1, 2, 0],
        [2, 0, 1],
        [2, 1, 0],
    ];

    for order in orders {
        let env = Env::default();
        let f = fixture(&env, [200, 300, 500], None);

        for index in order {
            f.client
                .release_milestone(&f.escrow_id, &index, &f.releaser);
        }

        assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Released);
        assert_eq!(f.client.get_milestones(&f.escrow_id).paid, 1_000);
        assert_eq!(f.token.balance(&f.payee), 1_000);
        assert_eq!(f.token.balance(&f.contract_id), 0);
    }
}

#[test]
fn replay_invalid_index_and_unauthorized_release_are_rejected() {
    let env = Env::default();
    let f = fixture(&env, [400, 600], None);
    let stranger = Address::generate(&env);

    assert_eq!(
        f.client
            .try_release_milestone(&f.escrow_id, &2, &f.releaser),
        Err(Ok(Error::InvalidMilestoneIndex))
    );
    assert_eq!(
        f.client.try_release_milestone(&f.escrow_id, &0, &stranger),
        Err(Ok(Error::Unauthorized))
    );
    f.client.release_milestone(&f.escrow_id, &0, &f.releaser);
    assert_eq!(
        f.client
            .try_release_milestone(&f.escrow_id, &0, &f.releaser),
        Err(Ok(Error::MilestoneAlreadyReleased))
    );
    assert_eq!(f.token.balance(&f.payee), 400);
    assert_eq!(f.token.balance(&f.contract_id), 600);
}

#[test]
fn refund_returns_only_unreleased_remainder_and_is_terminal() {
    let env = Env::default();
    let f = fixture(&env, [400, 600], None);

    f.client.release_milestone(&f.escrow_id, &0, &f.releaser);
    f.client.refund(&f.escrow_id, &f.releaser);

    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Refunded);
    assert_eq!(f.token.balance(&f.payee), 400);
    assert_eq!(f.token.balance(&f.payer), 600);
    assert_eq!(f.token.balance(&f.contract_id), 0);
    assert!(f
        .client
        .try_release_milestone(&f.escrow_id, &1, &f.releaser)
        .is_err());
    assert_eq!(
        f.client.try_refund(&f.escrow_id, &f.releaser),
        Err(Ok(Error::NotFunded))
    );
}

#[test]
fn ordinary_full_release_and_top_up_cannot_bypass_milestone_schedule() {
    let env = Env::default();
    let f = fixture(&env, [400, 600], None);

    assert_eq!(
        f.client.try_release(&f.escrow_id, &f.releaser),
        Err(Ok(Error::MilestoneReleaseRequired))
    );
    assert_eq!(
        f.client.try_settle(&f.escrow_id, &f.releaser, &0),
        Err(Ok(Error::MilestoneReleaseRequired))
    );
    assert_eq!(
        f.client.try_top_up(&f.escrow_id, &f.payer, &1),
        Err(Ok(Error::MilestoneReleaseRequired))
    );
    let ops = Vec::from_array(&env, [(f.escrow_id, SettleAction::Release)]);
    let outcomes = f.client.settle_many(&f.releaser, &ops);
    assert_eq!(outcomes.get(0), Some(Err(Error::MilestoneReleaseRequired)));
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Funded);
    assert_eq!(f.client.get_milestones(&f.escrow_id).paid, 0);
    assert_eq!(f.token.balance(&f.contract_id), 1_000);
}

#[test]
fn settle_many_refund_returns_only_unreleased_milestone_remainder() {
    let env = Env::default();
    let f = fixture(&env, [400, 600], None);
    f.client.release_milestone(&f.escrow_id, &0, &f.releaser);

    let ops = Vec::from_array(&env, [(f.escrow_id, SettleAction::Refund)]);
    let outcomes = f.client.settle_many(&f.releaser, &ops);
    assert_eq!(outcomes.get(0), Some(Ok(())));
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Refunded);
    assert_eq!(f.token.balance(&f.payee), 400);
    assert_eq!(f.token.balance(&f.payer), 600);
    assert_eq!(f.token.balance(&f.contract_id), 0);
    assert_eq!(f.client.get_milestones(&f.escrow_id).paid, 400);
}

#[test]
fn timeout_refund_by_stranger_returns_the_remainder_only() {
    let env = Env::default();
    env.ledger().set_timestamp(1_000);
    let f = fixture(&env, [250, 750], Some(1_100));
    let stranger = Address::generate(&env);

    f.client.release_milestone(&f.escrow_id, &0, &f.releaser);
    env.ledger().set_timestamp(1_100);
    f.client.refund(&f.escrow_id, &stranger);

    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Refunded);
    assert_eq!(f.token.balance(&f.payee), 250);
    assert_eq!(f.token.balance(&f.payer), 750);
    assert_eq!(f.token.balance(&f.contract_id), 0);
}

#[test]
fn ordinary_escrows_do_not_gain_milestone_behavior() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(admin).address();
    let token = TokenClient::new(&env, &token_id);
    let asset = StellarAssetClient::new(&env, &token_id);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    asset.mint(&payer, &1_000);
    let contract_id = env.register(
        EscrowContract,
        (Vec::<Address>::new(&env), Address::generate(&env)),
    );
    let client = EscrowContractClient::new(&env, &contract_id);
    let id = client.create_escrow(
        &payer,
        &payee,
        &token_id,
        &1_000,
        &String::from_str(&env, "ordinary"),
        &releaser,
        &None,
        &false,
        &None,
        &None,
        &None,
    );

    assert_eq!(client.try_get_milestones(&id), Err(Ok(Error::NotMilestone)));
    assert_eq!(
        client.try_release_milestone(&id, &0, &releaser),
        Err(Ok(Error::NotMilestone))
    );
    client.release(&id, &releaser);
    assert_eq!(client.get_status(&id), EscrowStatus::Released);
    assert_eq!(token.balance(&payee), 1_000);
}
