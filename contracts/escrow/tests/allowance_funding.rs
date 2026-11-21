// Phase E5 tests (issue #116): allowance-based creation consumes the payer's
// allowance through transfer_from while retaining the payer as funder.

use docforum_escrow::{EscrowContract, EscrowContractClient, EscrowStatus};
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    Address, Env, String, Vec,
};

struct Fixture<'a> {
    client: EscrowContractClient<'a>,
    token: TokenClient<'a>,
    token_id: Address,
    contract_id: Address,
    payer: Address,
    spender: Address,
    payee: Address,
    releaser: Address,
}

fn setup(env: &Env, allowance: i128, live_until: u32) -> Fixture<'_> {
    env.mock_all_auths();
    let token_id = env
        .register_stellar_asset_contract_v2(Address::generate(env))
        .address();
    let token = TokenClient::new(env, &token_id);
    let asset = StellarAssetClient::new(env, &token_id);
    let payer = Address::generate(env);
    let spender = Address::generate(env);
    let payee = Address::generate(env);
    let releaser = Address::generate(env);
    asset.mint(&payer, &1_000);
    token.approve(&payer, &spender, &allowance, &live_until);

    let contract_id = env.register(
        EscrowContract,
        (Vec::<Address>::new(env), Address::generate(env)),
    );
    let client = EscrowContractClient::new(env, &contract_id);
    Fixture {
        client,
        token,
        token_id,
        contract_id,
        payer,
        spender,
        payee,
        releaser,
    }
}

fn create(env: &Env, f: &Fixture<'_>, amount: i128) -> u64 {
    f.client.create_escrow_from(
        &f.spender,
        &f.payer,
        &f.payee,
        &f.token_id,
        &amount,
        &String::from_str(env, "allowance-116"),
        &f.releaser,
        &None,
        &false,
        &None,
        &None,
        &None,
    )
}

#[test]
fn allowance_creation_uses_spender_auth_but_records_payer_as_funder() {
    let env = Env::default();
    let f = setup(&env, 300, 100);
    let id = create(&env, &f, 300);

    let data = f.client.get_escrow(&id);
    assert_eq!(data.payer, f.payer);
    assert_eq!(data.funding_spender, Some(f.spender.clone()));
    assert_eq!(data.refund_to, f.payer);
    assert_eq!(f.token.balance(&f.payer), 700);
    assert_eq!(f.token.balance(&f.contract_id), 300);
    assert_eq!(f.token.allowance(&f.payer, &f.spender), 0);

    // The spender is not implicitly a releaser and cannot settle the escrow.
    assert!(f.client.try_release(&id, &f.spender).is_err());
    f.client.refund(&id, &f.releaser);
    assert_eq!(f.client.get_status(&id), EscrowStatus::Refunded);
    assert_eq!(f.token.balance(&f.payer), 1_000);
}

#[test]
fn allowance_creation_rejects_an_insufficient_allowance() {
    let env = Env::default();
    let f = setup(&env, 299, 100);

    assert!(f
        .client
        .try_create_escrow_from(
            &f.spender,
            &f.payer,
            &f.payee,
            &f.token_id,
            &300,
            &String::from_str(&env, "insufficient-allowance"),
            &f.releaser,
            &None,
            &false,
            &None,
            &None,
            &None,
        )
        .is_err());
    assert_eq!(f.token.balance(&f.payer), 1_000);
    assert_eq!(f.token.balance(&f.contract_id), 0);
}

#[test]
fn allowance_creation_rejects_an_expired_allowance() {
    let env = Env::default();
    let f = setup(&env, 300, 10);
    env.ledger().set_sequence_number(11);

    assert!(f
        .client
        .try_create_escrow_from(
            &f.spender,
            &f.payer,
            &f.payee,
            &f.token_id,
            &300,
            &String::from_str(&env, "expired-allowance"),
            &f.releaser,
            &None,
            &false,
            &None,
            &None,
            &None,
        )
        .is_err());
    assert_eq!(f.token.balance(&f.payer), 1_000);
    assert_eq!(f.token.balance(&f.contract_id), 0);
}
