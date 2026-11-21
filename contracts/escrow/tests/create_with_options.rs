use docforum_escrow::{Error, EscrowContract, EscrowContractClient, EscrowOptions, EscrowStatus};
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    Address, Env, String, Vec,
};

const CREATED_AT: u64 = 1_000;
const RELEASE_AT: u64 = 1_100;
const REFUND_AT: u64 = 1_200;

struct Fixture<'a> {
    client: EscrowContractClient<'a>,
    token: TokenClient<'a>,
    contract_id: Address,
    payee: Address,
    releasers: Vec<Address>,
    fee_recipient: Address,
    escrow_id: u64,
}

fn setup(env: &Env, options: EscrowOptions) -> Fixture<'_> {
    env.ledger().set_timestamp(CREATED_AT);
    env.mock_all_auths();
    let token_id = env
        .register_stellar_asset_contract_v2(Address::generate(env))
        .address();
    let token = TokenClient::new(env, &token_id);
    let asset = StellarAssetClient::new(env, &token_id);
    let payer = Address::generate(env);
    let payee = Address::generate(env);
    let fee_recipient = options
        .fee_recipient
        .clone()
        .unwrap_or_else(|| Address::generate(env));
    let releasers = options.releasers.clone();
    asset.mint(&payer, &1_000);
    let contract_id = env.register(
        EscrowContract,
        (Vec::<Address>::new(env), Address::generate(env)),
    );
    let client = EscrowContractClient::new(env, &contract_id);
    let escrow_id = client.create_escrow_with_options(
        &payer,
        &payee,
        &token_id,
        &300,
        &String::from_str(env, "options-test"),
        &options,
    );
    Fixture {
        client,
        token,
        contract_id,
        payee,
        releasers,
        fee_recipient,
        escrow_id,
    }
}

#[test]
fn options_combine_quorum_and_fee() {
    let env = Env::default();
    let first = Address::generate(&env);
    let second = Address::generate(&env);
    let fee_recipient = Address::generate(&env);
    let mut releasers = Vec::new(&env);
    releasers.push_back(first);
    releasers.push_back(second);
    let f = setup(
        &env,
        EscrowOptions {
            releasers,
            threshold: 2,
            refund_after: None,
            release_not_before: None,
            notify_payee: false,
            requires_acceptance: false,
            refund_to: None,
            fee_recipient: Some(fee_recipient),
            fee_bps: Some(1_000),
        },
    );
    let data = f.client.get_escrow(&f.escrow_id);
    assert_eq!(data.threshold, 2);
    assert_eq!(data.fee_bps, Some(1_000));
    assert_eq!(data.releasers, f.releasers);

    let mut approvals = Vec::new(&env);
    approvals.push_back(f.releasers.get(0).unwrap());
    approvals.push_back(f.releasers.get(1).unwrap());
    f.client.release_with_approvals(&f.escrow_id, &approvals);
    assert_eq!(f.token.balance(&f.fee_recipient), 30);
    assert_eq!(f.token.balance(&f.payee), 270);
    assert_eq!(f.token.balance(&f.contract_id), 0);
}

#[test]
fn options_combine_acceptance_and_release_time() {
    let env = Env::default();
    let releaser = Address::generate(&env);
    let mut releasers = Vec::new(&env);
    releasers.push_back(releaser.clone());
    let f = setup(
        &env,
        EscrowOptions {
            releasers,
            threshold: 1,
            refund_after: Some(REFUND_AT),
            release_not_before: Some(RELEASE_AT),
            notify_payee: false,
            requires_acceptance: true,
            refund_to: None,
            fee_recipient: None,
            fee_bps: None,
        },
    );
    env.ledger().set_timestamp(RELEASE_AT - 1);
    assert_eq!(
        f.client.try_release(&f.escrow_id, &releaser),
        Err(Ok(Error::ReleaseTooEarly))
    );
    env.ledger().set_timestamp(RELEASE_AT);
    assert_eq!(
        f.client.try_release(&f.escrow_id, &releaser),
        Err(Ok(Error::AcceptanceRequired))
    );
    f.client.accept(&f.escrow_id, &f.payee);
    f.client.release(&f.escrow_id, &releaser);
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Released);
    assert_eq!(f.token.balance(&f.payee), 300);
}

#[test]
fn options_reject_release_after_refund_deadline() {
    let env = Env::default();
    let releaser = Address::generate(&env);
    let mut releasers = Vec::new(&env);
    releasers.push_back(releaser);
    env.ledger().set_timestamp(CREATED_AT);
    env.mock_all_auths();
    let token_id = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    let payer = Address::generate(&env);
    StellarAssetClient::new(&env, &token_id).mint(&payer, &300);
    let contract_id = env.register(
        EscrowContract,
        (Vec::<Address>::new(&env), Address::generate(&env)),
    );
    let client = EscrowContractClient::new(&env, &contract_id);
    let result = client.try_create_escrow_with_options(
        &payer,
        &Address::generate(&env),
        &token_id,
        &300,
        &String::from_str(&env, "invalid-options"),
        &EscrowOptions {
            releasers,
            threshold: 1,
            refund_after: Some(REFUND_AT),
            release_not_before: Some(REFUND_AT + 1),
            notify_payee: false,
            requires_acceptance: false,
            refund_to: None,
            fee_recipient: None,
            fee_bps: None,
        },
    );
    assert_eq!(result, Err(Ok(Error::InvalidReleaseNotBefore)));
}
