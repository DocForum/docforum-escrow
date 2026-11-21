// Phase E5 tests — recurring escrows funded through token allowances
// (issue #115, ADR 0015). Per AGENTS.md hard rule 2: contract logic
// changes need tests here before merge.

use docforum_escrow::{EscrowContract, EscrowContractClient, EscrowStatus};
use soroban_sdk::{
    testutils::{Address as _, Ledger as _, MockAuth, MockAuthInvoke},
    token::{StellarAssetClient, TokenClient},
    Address, Env, IntoVal, String, Vec,
};

const AMOUNT: i128 = 100;
const PERIOD: u64 = 1_000;
const TOTAL_PERIODS: u32 = 3;
const FIRST_DUE: u64 = 10_000;

fn setup<'a>(env: &Env) -> (Address, TokenClient<'a>, StellarAssetClient<'a>) {
    let admin = Address::generate(env);
    let contract_id = env.register_stellar_asset_contract_v2(admin);
    let token = TokenClient::new(env, &contract_id.address());
    let asset = StellarAssetClient::new(env, &contract_id.address());
    (contract_id.address(), token, asset)
}

fn deploy(env: &Env) -> Address {
    env.register(
        EscrowContract,
        (Vec::<Address>::new(env), Address::generate(env)),
    )
}

fn create_schedule(
    client: &EscrowContractClient,
    env: &Env,
    payer: &Address,
    payee: &Address,
    token: &Address,
    releaser: &Address,
) -> u64 {
    client.create_schedule(
        payer,
        payee,
        token,
        &AMOUNT,
        &String::from_str(env, "subscription-1"),
        releaser,
        &None,
        &PERIOD,
        &TOTAL_PERIODS,
        &FIRST_DUE,
    )
}

#[test]
fn create_schedule_stores_the_schedule() {
    let env = Env::default();
    env.mock_all_auths();
    let (token_id, _token, _asset) = setup(&env);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    let contract_id = deploy(&env);
    let client = EscrowContractClient::new(&env, &contract_id);

    let schedule_id = create_schedule(&client, &env, &payer, &payee, &token_id, &releaser);

    assert_eq!(schedule_id, 0);
    let schedule = client.get_schedule(&schedule_id);
    assert_eq!(schedule.payer, payer);
    assert_eq!(schedule.payee, payee);
    assert_eq!(schedule.token, token_id);
    assert_eq!(schedule.amount, AMOUNT);
    assert_eq!(schedule.period_seconds, PERIOD);
    assert_eq!(schedule.total_periods, TOTAL_PERIODS);
    assert_eq!(schedule.periods_funded, 0);
    assert_eq!(schedule.next_due, FIRST_DUE);
    assert!(!schedule.cancelled);
    assert!(client.try_get_schedule(&999).is_err());
}

#[test]
fn create_schedule_rejects_invalid_terms() {
    let env = Env::default();
    env.mock_all_auths();
    let (token_id, _token, _asset) = setup(&env);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    let contract_id = deploy(&env);
    let client = EscrowContractClient::new(&env, &contract_id);
    let condition_ref = String::from_str(&env, "subscription-1");

    assert_eq!(
        client.try_create_schedule(
            &payer,
            &payee,
            &token_id,
            &0,
            &condition_ref,
            &releaser,
            &None,
            &PERIOD,
            &TOTAL_PERIODS,
            &FIRST_DUE,
        ),
        Err(Ok(docforum_escrow::Error::InvalidAmount))
    );
    assert_eq!(
        client.try_create_schedule(
            &payer,
            &payee,
            &token_id,
            &AMOUNT,
            &condition_ref,
            &releaser,
            &None,
            &0,
            &TOTAL_PERIODS,
            &FIRST_DUE,
        ),
        Err(Ok(docforum_escrow::Error::InvalidSchedule))
    );
    assert_eq!(
        client.try_create_schedule(
            &payer,
            &payee,
            &token_id,
            &AMOUNT,
            &condition_ref,
            &releaser,
            &None,
            &PERIOD,
            &0,
            &FIRST_DUE,
        ),
        Err(Ok(docforum_escrow::Error::InvalidSchedule))
    );
    let too_long_ref = String::from_str(&env, &"a".repeat(65));
    assert_eq!(
        client.try_create_schedule(
            &payer,
            &payee,
            &token_id,
            &AMOUNT,
            &too_long_ref,
            &releaser,
            &None,
            &PERIOD,
            &TOTAL_PERIODS,
            &FIRST_DUE,
        ),
        Err(Ok(docforum_escrow::Error::ConditionRefTooLong))
    );
    assert_eq!(
        client.try_create_schedule(
            &payer,
            &payee,
            &token_id,
            &AMOUNT,
            &condition_ref,
            &releaser,
            &Some(0),
            &PERIOD,
            &TOTAL_PERIODS,
            &FIRST_DUE,
        ),
        Err(Ok(docforum_escrow::Error::InvalidRefundAfter))
    );
}

#[test]
fn create_schedule_requires_payer_auth() {
    let env = Env::default();
    env.mock_all_auths();
    let (token_id, _token, asset) = setup(&env);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    asset.mint(&payer, &1_000);
    let contract_id = deploy(&env);
    let client = EscrowContractClient::new(&env, &contract_id);
    env.set_auths(&[]);

    assert!(client
        .try_create_schedule(
            &payer,
            &payee,
            &token_id,
            &AMOUNT,
            &String::from_str(&env, "subscription-1"),
            &releaser,
            &None,
            &PERIOD,
            &TOTAL_PERIODS,
            &FIRST_DUE,
        )
        .is_err());
}

#[test]
fn fund_next_creates_one_normal_escrow_per_period() {
    let env = Env::default();
    env.mock_all_auths();
    let (token_id, token, asset) = setup(&env);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    asset.mint(&payer, &1_000);
    let contract_id = deploy(&env);
    let client = EscrowContractClient::new(&env, &contract_id);
    asset.approve(&payer, &contract_id, &(AMOUNT * TOTAL_PERIODS as i128), &(env.ledger().get().sequence_number + 100_000));

    let schedule_id = create_schedule(&client, &env, &payer, &payee, &token_id, &releaser);
    env.ledger().set_timestamp(FIRST_DUE);

    let escrow_id = client.fund_next(&schedule_id);

    assert_eq!(escrow_id, 0);
    let escrow = client.get_escrow(&escrow_id);
    assert_eq!(escrow.payer, payer);
    assert_eq!(escrow.payee, payee);
    assert_eq!(escrow.token, token_id);
    assert_eq!(escrow.amount, AMOUNT);
    assert_eq!(escrow.status, EscrowStatus::Funded);
    assert_eq!(token.balance(&payer), 1_000 - AMOUNT);
    assert_eq!(token.balance(&contract_id), AMOUNT);
    let schedule = client.get_schedule(&schedule_id);
    assert_eq!(schedule.periods_funded, 1);
    assert_eq!(schedule.next_due, FIRST_DUE + PERIOD);
}

#[test]
fn fund_next_rejects_an_early_trigger() {
    let env = Env::default();
    env.mock_all_auths();
    let (token_id, token, asset) = setup(&env);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    asset.mint(&payer, &1_000);
    let contract_id = deploy(&env);
    let client = EscrowContractClient::new(&env, &contract_id);
    asset.approve(&payer, &contract_id, &(AMOUNT * TOTAL_PERIODS as i128), &(env.ledger().get().sequence_number + 100_000));

    let schedule_id = create_schedule(&client, &env, &payer, &payee, &token_id, &releaser);
    env.ledger().set_timestamp(FIRST_DUE - 1);

    assert_eq!(
        client.try_fund_next(&schedule_id),
        Err(Ok(docforum_escrow::Error::ScheduleTooEarly))
    );
    assert_eq!(token.balance(&payer), 1_000);
    assert_eq!(token.balance(&contract_id), 0);
    assert_eq!(client.get_schedule(&schedule_id).periods_funded, 0);
}

#[test]
fn fund_next_stops_when_the_allowance_runs_out() {
    let env = Env::default();
    env.mock_all_auths();
    let (token_id, _token, asset) = setup(&env);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    asset.mint(&payer, &1_000);
    let contract_id = deploy(&env);
    let client = EscrowContractClient::new(&env, &contract_id);
    asset.approve(&payer, &contract_id, &AMOUNT, &(env.ledger().get().sequence_number + 100_000));

    let schedule_id = create_schedule(&client, &env, &payer, &payee, &token_id, &releaser);
    env.ledger().set_timestamp(FIRST_DUE);
    assert_eq!(client.fund_next(&schedule_id), 0);

    env.ledger().set_timestamp(FIRST_DUE + PERIOD);
    assert_eq!(
        client.try_fund_next(&schedule_id),
        Err(Ok(docforum_escrow::Error::AllowanceExhausted))
    );
    assert_eq!(client.get_schedule(&schedule_id).periods_funded, 1);
}

#[test]
fn fund_next_respects_allowance_expiration() {
    let env = Env::default();
    env.mock_all_auths();
    let (token_id, _token, asset) = setup(&env);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    asset.mint(&payer, &1_000);
    let contract_id = deploy(&env);
    let client = EscrowContractClient::new(&env, &contract_id);
    let now_seq = env.ledger().get().sequence_number;
    asset.approve(
        &payer,
        &contract_id,
        &(AMOUNT * TOTAL_PERIODS as i128),
        &(now_seq + 5),
    );

    let schedule_id = create_schedule(&client, &env, &payer, &payee, &token_id, &releaser);
    env.ledger().set_timestamp(FIRST_DUE);
    assert_eq!(client.fund_next(&schedule_id), 0);

    env.ledger().set_sequence_number(now_seq + 6);
    env.ledger().set_timestamp(FIRST_DUE + PERIOD);
    assert_eq!(
        client.try_fund_next(&schedule_id),
        Err(Ok(docforum_escrow::Error::AllowanceExhausted))
    );
    assert_eq!(client.get_schedule(&schedule_id).periods_funded, 1);
}

#[test]
fn fund_next_needs_no_signature_from_keeper_or_payer() {
    let env = Env::default();
    env.mock_all_auths();
    let (token_id, _token, asset) = setup(&env);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    asset.mint(&payer, &1_000);
    let contract_id = deploy(&env);
    let client = EscrowContractClient::new(&env, &contract_id);
    asset.approve(&payer, &contract_id, &(AMOUNT * TOTAL_PERIODS as i128), &(env.ledger().get().sequence_number + 100_000));

    let schedule_id = create_schedule(&client, &env, &payer, &payee, &token_id, &releaser);
    env.set_auths(&[]);
    env.ledger().set_timestamp(FIRST_DUE);

    // The keeper is whoever calls; the payer signed nothing for this call.
    // The allowance is the authorization.
    assert!(client.try_fund_next(&schedule_id).is_ok());
    assert_eq!(client.get_schedule(&schedule_id).periods_funded, 1);
}

#[test]
fn late_trigger_funds_one_period_at_a_time() {
    let env = Env::default();
    env.mock_all_auths();
    let (token_id, _token, asset) = setup(&env);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    asset.mint(&payer, &1_000);
    let contract_id = deploy(&env);
    let client = EscrowContractClient::new(&env, &contract_id);
    asset.approve(&payer, &contract_id, &(AMOUNT * TOTAL_PERIODS as i128), &(env.ledger().get().sequence_number + 100_000));

    let schedule_id = create_schedule(&client, &env, &payer, &payee, &token_id, &releaser);
    env.ledger().set_timestamp(FIRST_DUE + 3 * PERIOD);

    assert_eq!(client.fund_next(&schedule_id), 0);
    let schedule = client.get_schedule(&schedule_id);
    assert_eq!(schedule.periods_funded, 1);
    assert_eq!(schedule.next_due, FIRST_DUE + PERIOD);

    // The next period is already due, so it funds immediately — but still
    // one escrow per call, never several at once.
    assert_eq!(client.fund_next(&schedule_id), 1);
    assert_eq!(client.get_schedule(&schedule_id).periods_funded, 2);
}

#[test]
fn cancel_stops_future_periods_and_leaves_escrows_alone() {
    let env = Env::default();
    env.mock_all_auths();
    let (token_id, _token, asset) = setup(&env);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    asset.mint(&payer, &1_000);
    let contract_id = deploy(&env);
    let client = EscrowContractClient::new(&env, &contract_id);
    asset.approve(&payer, &contract_id, &(AMOUNT * TOTAL_PERIODS as i128), &(env.ledger().get().sequence_number + 100_000));

    let schedule_id = create_schedule(&client, &env, &payer, &payee, &token_id, &releaser);
    env.ledger().set_timestamp(FIRST_DUE);
    let escrow_id = client.fund_next(&schedule_id);

    client.cancel_schedule(&schedule_id, &payer);
    assert!(client.get_schedule(&schedule_id).cancelled);

    env.ledger().set_timestamp(FIRST_DUE + PERIOD);
    assert_eq!(
        client.try_fund_next(&schedule_id),
        Err(Ok(docforum_escrow::Error::ScheduleCancelled))
    );
    assert_eq!(
        client.try_cancel_schedule(&schedule_id, &payer),
        Err(Ok(docforum_escrow::Error::ScheduleCancelled))
    );
    assert_eq!(client.get_status(&escrow_id), EscrowStatus::Funded);
}

#[test]
fn cancel_requires_the_payer() {
    let env = Env::default();
    env.mock_all_auths();
    let (token_id, _token, asset) = setup(&env);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    asset.mint(&payer, &1_000);
    let contract_id = deploy(&env);
    let client = EscrowContractClient::new(&env, &contract_id);
    asset.approve(&payer, &contract_id, &(AMOUNT * TOTAL_PERIODS as i128), &(env.ledger().get().sequence_number + 100_000));

    let schedule_id = create_schedule(&client, &env, &payer, &payee, &token_id, &releaser);
    let stranger = Address::generate(&env);
    assert_eq!(
        client.try_cancel_schedule(&schedule_id, &stranger),
        Err(Ok(docforum_escrow::Error::Unauthorized))
    );
    assert_eq!(
        client.try_cancel_schedule(&999, &payer),
        Err(Ok(docforum_escrow::Error::NotFound))
    );
    assert!(!client.get_schedule(&schedule_id).cancelled);
}

#[test]
fn complete_schedule_rejects_further_funding() {
    let env = Env::default();
    env.mock_all_auths();
    let (token_id, _token, asset) = setup(&env);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    asset.mint(&payer, &1_000);
    let contract_id = deploy(&env);
    let client = EscrowContractClient::new(&env, &contract_id);
    asset.approve(&payer, &contract_id, &(AMOUNT * TOTAL_PERIODS as i128), &(env.ledger().get().sequence_number + 100_000));

    let schedule_id = create_schedule(&client, &env, &payer, &payee, &token_id, &releaser);
    for period in 0..TOTAL_PERIODS {
        env.ledger().set_timestamp(FIRST_DUE + period as u64 * PERIOD);
        assert_eq!(client.fund_next(&schedule_id), period as u64);
    }
    env.ledger().set_timestamp(FIRST_DUE + TOTAL_PERIODS as u64 * PERIOD);
    assert_eq!(
        client.try_fund_next(&schedule_id),
        Err(Ok(docforum_escrow::Error::ScheduleComplete))
    );
    assert_eq!(
        client.get_schedule(&schedule_id).periods_funded,
        TOTAL_PERIODS
    );
}

#[test]
fn period_escrow_carries_the_schedules_refund_after() {
    let env = Env::default();
    env.mock_all_auths();
    let (token_id, _token, asset) = setup(&env);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    asset.mint(&payer, &1_000);
    let contract_id = deploy(&env);
    let client = EscrowContractClient::new(&env, &contract_id);
    asset.approve(&payer, &contract_id, &(AMOUNT * TOTAL_PERIODS as i128), &(env.ledger().get().sequence_number + 100_000));

    let deadline = FIRST_DUE + 100_000;
    let schedule_id = client.create_schedule(
        &payer,
        &payee,
        &token_id,
        &AMOUNT,
        &String::from_str(&env, "subscription-1"),
        &releaser,
        &Some(deadline),
        &PERIOD,
        &TOTAL_PERIODS,
        &FIRST_DUE,
    );
    env.ledger().set_timestamp(FIRST_DUE);
    let escrow_id = client.fund_next(&schedule_id);
    assert_eq!(client.get_escrow(&escrow_id).refund_after, Some(deadline));
}

#[test]
fn fund_next_uses_the_payers_signature_tree() {
    let env = Env::default();
    env.mock_all_auths();
    let (token_id, _token, asset) = setup(&env);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    asset.mint(&payer, &1_000);
    let contract_id = deploy(&env);
    let client = EscrowContractClient::new(&env, &contract_id);
    asset.approve(&payer, &contract_id, &(AMOUNT * TOTAL_PERIODS as i128), &(env.ledger().get().sequence_number + 100_000));

    let schedule_id = create_schedule(&client, &env, &payer, &payee, &token_id, &releaser);
    env.ledger().set_timestamp(FIRST_DUE);
    let transfer_from = MockAuthInvoke {
        contract: &token_id,
        fn_name: "transfer_from",
        args: (
            contract_id.clone(),
            payer.clone(),
            contract_id.clone(),
            AMOUNT,
        )
            .into_val(&env),
        sub_invokes: &[],
    };
    let invoke = MockAuthInvoke {
        contract: &contract_id,
        fn_name: "fund_next",
        args: (schedule_id,).into_val(&env),
        sub_invokes: &[transfer_from],
    };
    env.mock_auths(&[MockAuth {
        address: &contract_id,
        invoke: &invoke,
    }]);

    assert_eq!(client.fund_next(&schedule_id), 0);
}
