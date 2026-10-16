use docforum_escrow::{
    Error, EscrowContract, EscrowContractClient, EscrowStatus, VestingSchedule,
};
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    Address, Env, String,
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

fn fund_stream(env: &Env, amount: i128, schedule: VestingSchedule) -> Fixture<'_> {
    env.ledger().set_timestamp(100);
    env.mock_all_auths();

    let admin = Address::generate(env);
    let token_id = env.register_stellar_asset_contract_v2(admin).address();
    let token = TokenClient::new(env, &token_id);
    let asset = StellarAssetClient::new(env, &token_id);
    let payer = Address::generate(env);
    let payee = Address::generate(env);
    let releaser = Address::generate(env);
    asset.mint(&payer, &1_000);

    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(env, &contract_id);
    let escrow_id = client.create_streamed_escrow(
        &payer,
        &payee,
        &token_id,
        &amount,
        &String::from_str(env, "linear-stream"),
        &releaser,
        &None,
        &schedule,
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

fn schedule(start: u64, end: u64, cliff: Option<u64>) -> VestingSchedule {
    VestingSchedule { start, end, cliff }
}

#[test]
fn integer_vesting_rounds_down_and_withdrawals_never_exceed_total() {
    let env = Env::default();
    let f = fund_stream(&env, 7, schedule(100, 107, None));

    assert_eq!(f.client.get_vesting(&f.escrow_id).claimable_amount, 0);
    env.ledger().set_timestamp(101);
    assert_eq!(f.client.get_vesting(&f.escrow_id).vested_amount, 1);
    assert_eq!(f.client.withdraw(&f.escrow_id, &f.payee), 1);

    env.ledger().set_timestamp(103);
    let midway = f.client.get_vesting(&f.escrow_id);
    assert_eq!(midway.vested_amount, 3);
    assert_eq!(midway.withdrawn_amount, 1);
    assert_eq!(midway.claimable_amount, 2);
    assert_eq!(f.client.withdraw(&f.escrow_id, &f.payee), 2);

    env.ledger().set_timestamp(107);
    assert_eq!(f.client.withdraw(&f.escrow_id, &f.payee), 4);
    assert_eq!(f.token.balance(&f.payee), 7);
    assert_eq!(f.client.get_vesting(&f.escrow_id).withdrawn_amount, 7);
    assert_eq!(f.client.try_withdraw(&f.escrow_id, &f.payee), Err(Ok(Error::NothingToWithdraw)));
}

#[test]
fn cliff_unlocks_accrued_amount_at_boundary() {
    let env = Env::default();
    let f = fund_stream(&env, 10, schedule(100, 200, Some(150)));

    env.ledger().set_timestamp(149);
    assert_eq!(f.client.get_vesting(&f.escrow_id).vested_amount, 0);
    env.ledger().set_timestamp(150);
    assert_eq!(f.client.get_vesting(&f.escrow_id).vested_amount, 5);
    assert_eq!(f.client.withdraw(&f.escrow_id, &f.payee), 5);
}

#[test]
fn every_timestamp_in_small_stream_is_monotone_and_capped() {
    let env = Env::default();
    let total = 23_i128;
    let start = 100_u64;
    let end = 117_u64;
    let f = fund_stream(&env, total, schedule(start, end, None));
    let mut withdrawn = 0_i128;

    for now in start..=end {
        env.ledger().set_timestamp(now);
        let expected_vested = total * (now - start) as i128 / (end - start) as i128;
        let info = f.client.get_vesting(&f.escrow_id);
        assert_eq!(info.vested_amount, expected_vested);
        assert!(info.vested_amount >= withdrawn);
        let claimable = expected_vested - withdrawn;
        if claimable > 0 {
            assert_eq!(f.client.withdraw(&f.escrow_id, &f.payee), claimable);
            withdrawn += claimable;
        }
        assert!(withdrawn <= total);
    }

    assert_eq!(withdrawn, total);
    assert_eq!(f.token.balance(&f.payee), total);
}

#[test]
fn refund_pays_unwithdrawn_vested_amount_to_payee_and_remainder_to_payer() {
    let env = Env::default();
    let f = fund_stream(&env, 100, schedule(100, 200, None));

    env.ledger().set_timestamp(120);
    assert_eq!(f.client.withdraw(&f.escrow_id, &f.payee), 20);
    env.ledger().set_timestamp(150);
    f.client.refund(&f.escrow_id, &f.releaser);

    assert_eq!(f.token.balance(&f.payee), 50);
    assert_eq!(f.token.balance(&f.payer), 950);
    assert_eq!(f.token.balance(&f.contract_id), 0);
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Refunded);
    assert_eq!(f.client.get_vesting(&f.escrow_id).withdrawn_amount, 50);
    assert_eq!(f.client.get_vesting(&f.escrow_id).claimable_amount, 0);
}

#[test]
fn refund_before_stream_starts_returns_full_amount_to_payer() {
    let env = Env::default();
    let f = fund_stream(&env, 100, schedule(200, 300, None));

    f.client.refund(&f.escrow_id, &f.releaser);

    assert_eq!(f.token.balance(&f.payer), 1_000);
    assert_eq!(f.token.balance(&f.payee), 0);
}

#[test]
fn invalid_stream_schedules_are_rejected_before_funding() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(100);

    let admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(admin).address();
    let asset = StellarAssetClient::new(&env, &token_id);
    let token = TokenClient::new(&env, &token_id);
    let payer = Address::generate(&env);
    asset.mint(&payer, &1_000);
    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);

    let invalid = client.try_create_streamed_escrow(
        &payer,
        &Address::generate(&env),
        &token_id,
        &100,
        &String::from_str(&env, "invalid-stream"),
        &Address::generate(&env),
        &None,
        &schedule(100, 100, None),
    );
    let invalid_cliff = client.try_create_streamed_escrow(
        &payer,
        &Address::generate(&env),
        &token_id,
        &100,
        &String::from_str(&env, "invalid-cliff"),
        &Address::generate(&env),
        &None,
        &schedule(100, 200, Some(99)),
    );

    assert_eq!(invalid, Err(Ok(Error::InvalidVestingSchedule)));
    assert_eq!(invalid_cliff, Err(Ok(Error::InvalidVestingSchedule)));
    assert_eq!(token.balance(&payer), 1_000);
}
