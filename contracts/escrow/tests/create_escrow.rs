// Phase E1 tests — create_escrow + get_status. Per AGENTS.md hard rule 2:
// contract logic changes need tests here before merge.
//
// release()/refund() are Phase E2 — see tests/release_refund.rs.

use docforum_escrow::{EscrowContract, EscrowContractClient, EscrowStatus, CONTRACT_VERSION};
use soroban_sdk::{
    testutils::{Address as _, Events as _, MockAuth, MockAuthInvoke},
    token::{StellarAssetClient, TokenClient},
    Address, Env, IntoVal, String, Vec,
};

fn setup<'a>(env: &Env) -> (Address, TokenClient<'a>, StellarAssetClient<'a>) {
    let admin = Address::generate(env);
    let contract_id = env.register_stellar_asset_contract_v2(admin);
    let token = TokenClient::new(env, &contract_id.address());
    let asset = StellarAssetClient::new(env, &contract_id.address());
    (contract_id.address(), token, asset)
}

#[test]
fn version_reports_the_contract_semver() {
    let env = Env::default();
    let contract_id = env.register(
        EscrowContract,
        (
            Vec::<Address>::new(&env),
            Vec::<Address>::new(&env),
            Address::generate(&env),
        ),
    );
    let client = EscrowContractClient::new(&env, &contract_id);

    // Compared with the constant, not a literal: the version is bumped by the
    // maintainer fold (contract-changes.d/), and a literal here broke every
    // open contract PR whenever it moved.
    assert_eq!(client.version(), String::from_str(&env, CONTRACT_VERSION));
}

#[test]
fn create_escrow_locks_funds_and_reports_funded() {
    let env = Env::default();
    env.mock_all_auths();

    let (token_id, token, asset) = setup(&env);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    asset.mint(&payer, &1_000);

    let contract_id = env.register(
        EscrowContract,
        (
            Vec::<Address>::new(&env),
            Vec::<Address>::new(&env),
            Address::generate(&env),
        ),
    );
    let client = EscrowContractClient::new(&env, &contract_id);

    let escrow_id = client.create_escrow(
        &payer,
        &payee,
        &token_id,
        &300,
        &String::from_str(&env, "opaque-condition-ref"),
        &releaser,
        &None,
        &false,
        &None,
        &None,
        &None,
    );

    assert_eq!(escrow_id, 0);
    assert_eq!(
        env.events()
            .all()
            .filter_by_contract(&contract_id)
            .events()
            .len(),
        1
    );
    assert_eq!(token.balance(&payer), 700);
    assert_eq!(token.balance(&contract_id), 300);
    assert_eq!(client.get_status(&escrow_id), EscrowStatus::Funded);
}

#[test]
fn create_escrow_assigns_sequential_ids() {
    let env = Env::default();
    env.mock_all_auths();

    let (token_id, _token, asset) = setup(&env);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    asset.mint(&payer, &1_000);

    let contract_id = env.register(
        EscrowContract,
        (
            Vec::<Address>::new(&env),
            Vec::<Address>::new(&env),
            Address::generate(&env),
        ),
    );
    let client = EscrowContractClient::new(&env, &contract_id);

    let first = client.create_escrow(
        &payer,
        &payee,
        &token_id,
        &100,
        &String::from_str(&env, "ref-a"),
        &releaser,
        &None,
        &false,
        &None,
        &None,
        &None,
    );
    let second = client.create_escrow(
        &payer,
        &payee,
        &token_id,
        &100,
        &String::from_str(&env, "ref-b"),
        &releaser,
        &None,
        &false,
        &None,
        &None,
        &None,
    );

    assert_eq!(first, 0);
    assert_eq!(second, 1);
}

#[test]
fn create_escrow_rejects_non_positive_amount() {
    let env = Env::default();
    env.mock_all_auths();

    let (token_id, _token, _asset) = setup(&env);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);

    let contract_id = env.register(
        EscrowContract,
        (
            Vec::<Address>::new(&env),
            Vec::<Address>::new(&env),
            Address::generate(&env),
        ),
    );
    let client = EscrowContractClient::new(&env, &contract_id);

    let result = client.try_create_escrow(
        &payer,
        &payee,
        &token_id,
        &0,
        &String::from_str(&env, "ref"),
        &releaser,
        &None,
        &false,
        &None,
        &None,
        &None,
    );
    assert!(result.is_err());
}

#[test]
fn get_status_errors_for_unknown_escrow() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(
        EscrowContract,
        (
            Vec::<Address>::new(&env),
            Vec::<Address>::new(&env),
            Address::generate(&env),
        ),
    );
    let client = EscrowContractClient::new(&env, &contract_id);

    let result = client.try_get_status(&999);
    assert!(result.is_err());
}

#[test]
fn create_escrow_rejects_condition_ref_that_is_too_long() {
    let env = Env::default();
    env.mock_all_auths();

    let (token_id, _token, asset) = setup(&env);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    asset.mint(&payer, &1_000);

    let contract_id = env.register(
        EscrowContract,
        (
            Vec::<Address>::new(&env),
            Vec::<Address>::new(&env),
            Address::generate(&env),
        ),
    );
    let client = EscrowContractClient::new(&env, &contract_id);

    // 64 bytes is accepted (the bound is inclusive).
    let max_ref = "a".repeat(64);
    let result = client.try_create_escrow(
        &payer,
        &payee,
        &token_id,
        &300,
        &String::from_str(&env, &max_ref),
        &releaser,
        &None,
        &false,
        &None,
        &None,
        &None,
    );
    assert!(result.is_ok());

    // 65 bytes is rejected with ConditionRefTooLong.
    let too_long_ref = "a".repeat(65);
    let result = client.try_create_escrow(
        &payer,
        &payee,
        &token_id,
        &300,
        &String::from_str(&env, &too_long_ref),
        &releaser,
        &None,
        &false,
        &None,
        &None,
        &None,
    );
    assert!(result.is_err());
    assert_eq!(
        result.unwrap_err(),
        Ok(docforum_escrow::Error::ConditionRefTooLong)
    );
}

#[test]
fn callback_opt_in_requires_payee_authorization() {
    let env = Env::default();
    env.mock_all_auths();
    let (token_id, token, asset) = setup(&env);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    asset.mint(&payer, &1_000);

    let contract_id = env.register(
        EscrowContract,
        (
            Vec::<Address>::new(&env),
            Vec::<Address>::new(&env),
            Address::generate(&env),
        ),
    );
    let client = EscrowContractClient::new(&env, &contract_id);
    let condition_ref = String::from_str(&env, "payee-opt-in-auth");
    let invoke = MockAuthInvoke {
        contract: &contract_id,
        fn_name: "create_escrow",
        args: (
            payer.clone(),
            payee.clone(),
            token_id.clone(),
            300i128,
            condition_ref.clone(),
            releaser.clone(),
            None::<u64>,
            true,
        )
            .into_val(&env),
        sub_invokes: &[],
    };

    // The payer authorizes creation, but the opted-in payee does not.
    env.mock_auths(&[MockAuth {
        address: &payer,
        invoke: &invoke,
    }]);
    assert!(client
        .try_create_escrow(
            &payer,
            &payee,
            &token_id,
            &300,
            &condition_ref,
            &releaser,
            &None,
            &true,
            &None,
            &None,
            &None,
        )
        .is_err());
    assert_eq!(token.balance(&payer), 1_000);
    assert!(matches!(
        client.try_get_status(&0),
        Err(Ok(docforum_escrow::Error::NotFound))
    ));
}

fn batch_of(env: &Env, token: &Address, count: u32) -> Vec<docforum_escrow::CreateItem> {
    let mut items = Vec::new(env);
    for _ in 0..count {
        items.push_back(docforum_escrow::CreateItem {
            payee: Address::generate(env),
            token: token.clone(),
            amount: 1,
            condition_ref: String::from_str(env, "batch"),
            releaser: Address::generate(env),
            refund_after: None,
        });
    }
    items
}

#[test]
fn create_escrows_rejects_one_item_over_the_batch_limit() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _, asset) = setup(&env);
    let contract_id = env.register(
        EscrowContract,
        (Vec::<Address>::new(&env), Address::generate(&env)),
    );
    let client = EscrowContractClient::new(&env, &contract_id);
    let payer = Address::generate(&env);
    asset.mint(&payer, &100);

    let oversized = batch_of(&env, &token, docforum_escrow::MAX_BATCH_SIZE + 1);
    assert_eq!(
        client.try_create_escrows(&payer, &oversized),
        Err(Ok(docforum_escrow::Error::BatchTooLarge))
    );

    // Recording auths for a full batch needs more memory than the default
    // test budget allows. Mainnet's limits on the invocation still apply.
    env.cost_estimate().budget().reset_unlimited();
    let full = batch_of(&env, &token, docforum_escrow::MAX_BATCH_SIZE);
    assert_eq!(
        client.create_escrows(&payer, &full).len(),
        docforum_escrow::MAX_BATCH_SIZE
    );
}

#[test]
fn create_escrows_creates_every_item_in_input_order() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, token_client, asset) = setup(&env);
    let contract_id = env.register(
        EscrowContract,
        (Vec::<Address>::new(&env), Address::generate(&env)),
    );
    let client = EscrowContractClient::new(&env, &contract_id);
    let payer = Address::generate(&env);
    asset.mint(&payer, &100);
    let mut items = batch_of(&env, &token, 3);
    for (index, amount) in [10i128, 20, 30].into_iter().enumerate() {
        let mut item = items.get_unchecked(index as u32);
        item.amount = amount;
        items.set(index as u32, item);
    }

    let ids = client.create_escrows(&payer, &items);

    assert_eq!(ids, soroban_sdk::vec![&env, 0u64, 1, 2]);
    for (id, item) in ids.iter().zip(items.iter()) {
        let stored = client.get_escrow(&id);
        assert_eq!(stored.payee, item.payee);
        assert_eq!(stored.amount, item.amount);
        assert_eq!(client.get_status(&id), EscrowStatus::Funded);
    }
    assert_eq!(token_client.balance(&contract_id), 60);
    assert_eq!(token_client.balance(&payer), 40);
}

#[test]
fn create_escrows_needs_one_payer_authorization_covering_every_transfer() {
    let env = Env::default();
    let (token, token_client, asset) = setup(&env);
    let contract_id = env.register(
        EscrowContract,
        (Vec::<Address>::new(&env), Address::generate(&env)),
    );
    let client = EscrowContractClient::new(&env, &contract_id);
    let payer = Address::generate(&env);
    env.mock_all_auths();
    asset.mint(&payer, &100);
    env.set_auths(&[]);
    let items = batch_of(&env, &token, 2);

    // Nobody signed: nothing is created.
    assert!(client.try_create_escrows(&payer, &items).is_err());
    assert_eq!(token_client.balance(&payer), 100);

    let transfer = MockAuthInvoke {
        contract: &token,
        fn_name: "transfer",
        args: (payer.clone(), contract_id.clone(), 1i128).into_val(&env),
        sub_invokes: &[],
    };
    let ids = client
        .mock_auths(&[MockAuth {
            address: &payer,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "create_escrows",
                args: (payer.clone(), items.clone()).into_val(&env),
                sub_invokes: &[transfer.clone(), transfer],
            },
        }])
        .create_escrows(&payer, &items);

    assert_eq!(ids.len(), 2);
    assert_eq!(token_client.balance(&payer), 98);
}

#[test]
fn create_escrows_reverts_the_whole_batch_when_one_item_is_invalid() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, token_client, asset) = setup(&env);
    let contract_id = env.register(
        EscrowContract,
        (Vec::<Address>::new(&env), Address::generate(&env)),
    );
    let client = EscrowContractClient::new(&env, &contract_id);
    let payer = Address::generate(&env);
    asset.mint(&payer, &100);
    let mut items = batch_of(&env, &token, 2);
    let mut invalid = items.get_unchecked(1);
    invalid.amount = 0;
    items.set(1, invalid);

    assert_eq!(
        client.try_create_escrows(&payer, &items),
        Err(Ok(docforum_escrow::Error::InvalidAmount))
    );

    assert_eq!(token_client.balance(&payer), 100);
    assert_eq!(token_client.balance(&contract_id), 0);
    assert!(client.try_get_status(&0).is_err());
}

/// `MAX_BATCH_SIZE` items with a maximum-length `condition_ref` and a refund
/// deadline must fit Mainnet's per-transaction limits. The binding one is
/// contract events + return value (16,384 bytes), so this sizes the events the
/// batch actually emitted (XDR, as the network meters them) and requires at
/// least 15% headroom. `Env::default()` enforces the other limits.
#[test]
fn max_create_batch_fits_mainnet_limits() {
    use soroban_sdk::xdr::{Limits, WriteXdr};

    let env = Env::default();
    env.mock_all_auths();
    let (token, _, asset) = setup(&env);
    let contract_id = env.register(
        EscrowContract,
        (Vec::<Address>::new(&env), Address::generate(&env)),
    );
    let client = EscrowContractClient::new(&env, &contract_id);
    let payer = Address::generate(&env);
    asset.mint(&payer, &1_000);
    let mut items = batch_of(&env, &token, docforum_escrow::MAX_BATCH_SIZE);
    for index in 0..items.len() {
        let mut item = items.get_unchecked(index);
        item.condition_ref = String::from_str(&env, &"r".repeat(64));
        item.refund_after = Some(u64::MAX);
        items.set(index, item);
    }

    // See create_escrows_rejects_one_item_over_the_batch_limit.
    env.cost_estimate().budget().reset_unlimited();
    let ids = client.create_escrows(&payer, &items);
    let events_bytes: usize = env
        .events()
        .all()
        .events()
        .iter()
        .map(|event| event.to_xdr(Limits::none()).unwrap().len())
        .sum();

    assert_eq!(ids.len(), docforum_escrow::MAX_BATCH_SIZE);
    // One id per item in the return value; a generous allowance.
    let return_bytes = 16 * docforum_escrow::MAX_BATCH_SIZE as usize + 64;
    assert!(
        events_bytes + return_bytes <= 16_384 * 85 / 100,
        "events {events_bytes} + return {return_bytes} bytes"
    );
}
