// Phase E5 tests (issue #116): allowance-based creation consumes the payer's
// allowance through transfer_from while retaining the payer as funder.

use docforum_escrow::{EscrowContract, EscrowContractClient, EscrowStatus};
use soroban_sdk::{
    testutils::{Address as _, Ledger as _, MockAuth, MockAuthInvoke},
    token::{StellarAssetClient, TokenClient},
    Address, Env, IntoVal, String, Vec,
};

struct Fixture<'a> {
    client: EscrowContractClient<'a>,
    token: TokenClient<'a>,
    token_id: Address,
    contract_id: Address,
    custodian: Address,
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

    let custodian = Address::generate(env);
    let contract_id = env.register(
        EscrowContract,
        (Vec::<Address>::new(env), custodian.clone()),
    );
    let client = EscrowContractClient::new(env, &contract_id);
    Fixture {
        client,
        token,
        token_id,
        contract_id,
        custodian,
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

fn create_without_auth(env: &Env, f: &Fixture<'_>, amount: i128) -> bool {
    f.client
        .try_create_escrow_from(
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
        .is_err()
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
    assert_eq!(f.token.balance(&f.spender), 0);
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
    assert_eq!(f.token.allowance(&f.payer, &f.spender), 299);
    assert!(f.client.try_get_status(&0).is_err());
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
    assert_eq!(f.token.allowance(&f.payer, &f.spender), 0);
    assert!(f.client.try_get_status(&0).is_err());
}

#[test]
fn allowance_creation_requires_only_the_spenders_signature() {
    let env = Env::default();
    let f = setup(&env, 300, 100);
    let condition_ref = String::from_str(&env, "spender-only-auth");
    let transfer_from = MockAuthInvoke {
        contract: &f.token_id,
        fn_name: "transfer_from",
        args: (
            f.spender.clone(),
            f.payer.clone(),
            f.contract_id.clone(),
            300i128,
        )
            .into_val(&env),
        sub_invokes: &[],
    };
    let create = MockAuthInvoke {
        contract: &f.contract_id,
        fn_name: "create_escrow_from",
        args: (
            f.spender.clone(),
            f.payer.clone(),
            f.payee.clone(),
            f.token_id.clone(),
            300i128,
            condition_ref.clone(),
            f.releaser.clone(),
            None::<u64>,
            false,
            None::<Address>,
            None::<Address>,
            None::<u32>,
        )
            .into_val(&env),
        sub_invokes: &[transfer_from],
    };
    let id = f
        .client
        .mock_auths(&[MockAuth {
            address: &f.spender,
            invoke: &create,
        }])
        .create_escrow_from(
            &f.spender,
            &f.payer,
            &f.payee,
            &f.token_id,
            &300,
            &condition_ref,
            &f.releaser,
            &None,
            &false,
            &None,
            &None,
            &None,
        );

    assert_eq!(id, 0);
    let auths = env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, f.spender);
    assert_eq!(f.client.get_escrow(&id).payer, f.payer);
}

#[test]
fn allowance_creation_fails_without_the_spenders_signature() {
    let env = Env::default();
    let f = setup(&env, 300, 100);
    env.set_auths(&[]);

    assert!(create_without_auth(&env, &f, 300));
    assert_eq!(f.token.balance(&f.payer), 1_000);
    assert_eq!(f.token.balance(&f.contract_id), 0);
    assert_eq!(f.token.allowance(&f.payer, &f.spender), 300);
    assert!(f.client.try_get_status(&0).is_err());
}

#[test]
fn allowance_creation_is_blocked_while_paused_without_consuming_allowance() {
    let env = Env::default();
    let f = setup(&env, 300, 100);
    f.client.pause(&f.custodian);

    assert!(f
        .client
        .try_create_escrow_from(
            &f.spender,
            &f.payer,
            &f.payee,
            &f.token_id,
            &300,
            &String::from_str(&env, "paused-allowance"),
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
    assert_eq!(f.token.allowance(&f.payer, &f.spender), 300);
    assert!(f.client.try_get_status(&0).is_err());
}

#[test]
fn allowance_creation_respects_the_token_allowlist() {
    let env = Env::default();
    env.mock_all_auths();
    let token_id = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    let token = TokenClient::new(&env, &token_id);
    let asset = StellarAssetClient::new(&env, &token_id);
    let payer = Address::generate(&env);
    let spender = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    asset.mint(&payer, &1_000);
    token.approve(&payer, &spender, &300, &100);

    let mut allowlist = Vec::new(&env);
    allowlist.push_back(Address::generate(&env));
    let contract_id = env.register(EscrowContract, (allowlist, Address::generate(&env)));
    let client = EscrowContractClient::new(&env, &contract_id);
    assert!(client
        .try_create_escrow_from(
            &spender,
            &payer,
            &payee,
            &token_id,
            &300,
            &String::from_str(&env, "disallowed-allowance"),
            &releaser,
            &None,
            &false,
            &None,
            &None,
            &None,
        )
        .is_err());
    assert_eq!(token.balance(&payer), 1_000);
    assert_eq!(token.balance(&contract_id), 0);
    assert_eq!(token.allowance(&payer, &spender), 300);
    assert!(client.try_get_status(&0).is_err());
}
