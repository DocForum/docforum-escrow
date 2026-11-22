use docforum_escrow::{Error, EscrowContract, EscrowContractClient, EscrowStatus};
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    Address, Env, String, Vec,
};

struct Fixture<'a> {
    client: EscrowContractClient<'a>,
    token: TokenClient<'a>,
    payer: Address,
    payee: Address,
    releaser: Address,
    id: u64,
}

fn setup(env: &Env) -> Fixture<'_> {
    env.mock_all_auths();
    let admin = Address::generate(env);
    let token_id = env.register_stellar_asset_contract_v2(admin).address();
    let token = TokenClient::new(env, &token_id);
    let asset = StellarAssetClient::new(env, &token_id);
    let payer = Address::generate(env);
    let payee = Address::generate(env);
    let releaser = Address::generate(env);
    asset.mint(&payer, &500);
    let contract_id = env.register(
        EscrowContract,
        (
            Vec::<Address>::new(env),
            Address::generate(env),
            soroban_sdk::Vec::<(Address, i128)>::new(&env),
        ),
    );
    let client = EscrowContractClient::new(env, &contract_id);
    let id = client.create_escrow(
        &payer,
        &payee,
        &token_id,
        &300,
        &String::from_str(env, "split-test"),
        &releaser,
        &None,
        &false,
        &None,
        &None,
        &None,
    );
    Fixture {
        client,
        token,
        payer,
        payee,
        releaser,
        id,
    }
}

#[test]
fn split_settlement_supports_zero_full_and_partial_payouts() {
    let env = Env::default();
    let zero = setup(&env);
    zero.client.settle(&zero.id, &zero.releaser, &0);
    assert_eq!(zero.token.balance(&zero.payee), 0);
    assert_eq!(zero.token.balance(&zero.payer), 500);
    assert_eq!(zero.client.get_status(&zero.id), EscrowStatus::Released);

    let full = setup(&env);
    full.client.settle(&full.id, &full.releaser, &300);
    assert_eq!(full.token.balance(&full.payee), 300);
    assert_eq!(full.token.balance(&full.payer), 200);

    let partial = setup(&env);
    partial.client.settle(&partial.id, &partial.releaser, &120);
    assert_eq!(partial.token.balance(&partial.payee), 120);
    assert_eq!(partial.token.balance(&partial.payer), 380);
}

#[test]
fn split_settlement_rejects_amounts_outside_the_escrow_range() {
    let env = Env::default();
    let negative = setup(&env);
    assert!(negative
        .client
        .try_settle(&negative.id, &negative.releaser, &-1)
        .is_err());

    let too_large = setup(&env);
    assert!(too_large
        .client
        .try_settle(&too_large.id, &too_large.releaser, &301)
        .is_err());

    let overflow = setup(&env);
    assert!(overflow
        .client
        .try_settle(&overflow.id, &overflow.releaser, &i128::MAX)
        .is_err());
}

#[test]
fn split_settlement_respects_the_release_time_lock() {
    let env = Env::default();
    env.ledger().set_timestamp(1_000);
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(admin).address();
    let token = TokenClient::new(&env, &token_id);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    StellarAssetClient::new(&env, &token_id).mint(&payer, &500);
    let contract_id = env.register(
        EscrowContract,
        (
            Vec::<Address>::new(&env),
            Address::generate(&env),
            soroban_sdk::Vec::<(Address, i128)>::new(&env),
        ),
    );
    let client = EscrowContractClient::new(&env, &contract_id);
    let id = client.create_escrow_release_time(
        &payer,
        &payee,
        &token_id,
        &300,
        &String::from_str(&env, "split-lock"),
        &releaser,
        &None,
        &false,
        &None,
        &Some(1_100),
        &None,
        &None,
    );

    assert_eq!(
        client.try_settle(&id, &releaser, &120),
        Err(Ok(Error::ReleaseTooEarly))
    );
    assert_eq!(token.balance(&payee), 0);

    env.ledger().set_timestamp(1_100);
    client.settle(&id, &releaser, &120);
    assert_eq!(token.balance(&payee), 120);
    assert_eq!(token.balance(&payer), 380);
}

#[test]
fn split_settlement_rejects_pooled_escrows() {
    let env = Env::default();
    env.ledger().set_timestamp(1_000);
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(admin).address();
    let creator = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    let contract_id = env.register(
        EscrowContract,
        (
            Vec::<Address>::new(&env),
            Address::generate(&env),
            soroban_sdk::Vec::<(Address, i128)>::new(&env),
        ),
    );
    let client = EscrowContractClient::new(&env, &contract_id);
    let id = client.create_pooled_escrow(
        &creator,
        &payee,
        &token_id,
        &300,
        &String::from_str(&env, "split-pooled"),
        &releaser,
        &2_000,
    );

    assert_eq!(
        client.try_settle(&id, &releaser, &0),
        Err(Ok(Error::NotSupportedForPooled))
    );
}

/// Escrow of 1_000 with a 10 % (1_000 bps) protocol fee.
fn setup_with_fee(env: &Env) -> (Fixture<'_>, Address) {
    env.mock_all_auths();
    let admin = Address::generate(env);
    let token_id = env.register_stellar_asset_contract_v2(admin).address();
    let token = TokenClient::new(env, &token_id);
    let asset = StellarAssetClient::new(env, &token_id);
    let payer = Address::generate(env);
    let payee = Address::generate(env);
    let releaser = Address::generate(env);
    let fee_recipient = Address::generate(env);
    asset.mint(&payer, &1_000);
    let contract_id = env.register(
        EscrowContract,
        (
            Vec::<Address>::new(env),
            Address::generate(env),
            soroban_sdk::Vec::<(Address, i128)>::new(&env),
        ),
    );
    let client = EscrowContractClient::new(env, &contract_id);
    let id = client.create_escrow(
        &payer,
        &payee,
        &token_id,
        &1_000,
        &String::from_str(env, "split-fee"),
        &releaser,
        &None,
        &false,
        &None,
        &Some(fee_recipient.clone()),
        &Some(1_000u32),
    );
    (
        Fixture {
            client,
            token,
            payer,
            payee,
            releaser,
            id,
        },
        fee_recipient,
    )
}

#[test]
fn split_settlement_charges_the_fee_on_the_payee_share_only() {
    let env = Env::default();
    let (f, fee_recipient) = setup_with_fee(&env);
    f.client.settle(&f.id, &f.releaser, &400);
    // 10 % of the 400 payee share; the 600 returned to the payer is untouched.
    assert_eq!(f.token.balance(&fee_recipient), 40);
    assert_eq!(f.token.balance(&f.payee), 360);
    assert_eq!(f.token.balance(&f.payer), 600);
}

#[test]
fn split_settlement_of_zero_is_a_fee_free_refund() {
    let env = Env::default();
    let (f, fee_recipient) = setup_with_fee(&env);
    f.client.settle(&f.id, &f.releaser, &0);
    assert_eq!(f.token.balance(&fee_recipient), 0);
    assert_eq!(f.token.balance(&f.payer), 1_000);
}

#[test]
fn split_settlement_of_everything_matches_release() {
    let env = Env::default();
    let (f, fee_recipient) = setup_with_fee(&env);
    f.client.settle(&f.id, &f.releaser, &1_000);
    assert_eq!(f.token.balance(&fee_recipient), 100);
    assert_eq!(f.token.balance(&f.payee), 900);
    assert_eq!(f.token.balance(&f.payer), 0);
}

#[test]
fn split_settlement_rejects_multi_payee_escrows() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(admin).address();
    let payer = Address::generate(&env);
    StellarAssetClient::new(&env, &token_id).mint(&payer, &1_000);
    let releaser = Address::generate(&env);
    let contract_id = env.register(
        EscrowContract,
        (
            Vec::<Address>::new(&env),
            Address::generate(&env),
            soroban_sdk::Vec::<(Address, i128)>::new(&env),
        ),
    );
    let client = EscrowContractClient::new(&env, &contract_id);
    let mut payees = Vec::new(&env);
    payees.push_back(docforum_escrow::PayeeShare {
        payee: Address::generate(&env),
        basis_points: 6_000,
    });
    payees.push_back(docforum_escrow::PayeeShare {
        payee: Address::generate(&env),
        basis_points: 4_000,
    });
    let id = client.create_split_escrow(
        &payer,
        &payees,
        &token_id,
        &1_000,
        &String::from_str(&env, "split-multi"),
        &releaser,
        &None,
        &false,
        &None,
        &None,
        &None,
    );
    assert_eq!(
        client.try_settle(&id, &releaser, &500),
        Err(Ok(Error::SettlementNotSupported))
    );
}

#[test]
fn split_settlement_reclaims_the_record_like_other_settlements() {
    let env = Env::default();
    let f = setup(&env);
    f.client.settle(&f.id, &f.releaser, &120);
    assert_eq!(f.client.get_status(&f.id), EscrowStatus::Released);
    assert!(matches!(
        f.client.try_get_escrow(&f.id),
        Err(Ok(Error::NotFound))
    ));
}
