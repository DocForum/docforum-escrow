use docforum_escrow::{EscrowContract, EscrowContractClient, EscrowStatus, MigrationData};
use soroban_sdk::{
    testutils::{Address as _, MockAuth, MockAuthInvoke},
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
fn successful_migration_moves_funds_and_marks_source_as_migrated() {
    let env = Env::default();
    env.mock_all_auths();

    let (token_id, token, asset) = setup(&env);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    let source_contract = env.register(EscrowContract, (Vec::<Address>::new(&env), Vec::<Address>::new(&env)));
    let source_client = EscrowContractClient::new(&env, &source_contract);
    let destination_contract = env.register(EscrowContract, (Vec::<Address>::new(&env), Vec::from_array(&env, [source_contract.clone()])));
    let destination_client = EscrowContractClient::new(&env, &destination_contract);

    asset.mint(&payer, &1_000);
    let escrow_id = source_client.create_escrow(
        &payer,
        &payee,
        &token_id,
        &300,
        &String::from_str(&env, "migration-ref"),
        &releaser,
        &None,
        &false,
        &None,
    );

    let approvals = Vec::from_array(&env, [releaser]);
    assert_eq!(source_client.export_to(&escrow_id, &destination_contract, &approvals), 0);
    assert_eq!(source_client.get_status(&escrow_id), EscrowStatus::Migrated);
    assert_eq!(destination_client.get_status(&0), EscrowStatus::Funded);
    assert_eq!(token.balance(&destination_contract), 300);
    assert_eq!(token.balance(&source_contract), 0);
}

#[test]
fn migration_requires_both_payer_and_releaser_consent() {
    let env = Env::default();
    env.mock_all_auths();

    let (token_id, _token, asset) = setup(&env);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releasers = Vec::from_array(
        &env,
        [Address::generate(&env), Address::generate(&env), Address::generate(&env)],
    );
    let src = env.register(EscrowContract, (Vec::<Address>::new(&env), Vec::<Address>::new(&env)));
    let dest = env.register(EscrowContract, (Vec::<Address>::new(&env), Vec::from_array(&env, [src.clone()])));
    asset.mint(&payer, &1_000);

    let source = EscrowContractClient::new(&env, &src);
    let escrow_id = source.create_escrow_with_releasers(
        &payer,
        &payee,
        &token_id,
        &200,
        &String::from_str(&env, "ref"),
        &releasers,
        &2,
        &None,
        &false,
        &None,
    );

    let first = releasers.get(0).unwrap();
    let second = releasers.get(1).unwrap();
    let approvals = Vec::from_array(&env, [first.clone(), second.clone()]);
    let args = (escrow_id, dest.clone(), approvals.clone()).into_val(&env);
    let invoke = MockAuthInvoke {
        contract: &src,
        fn_name: "export_to",
        args,
        sub_invokes: &[],
    };

    env.mock_auths(&[]);
    assert!(source.try_export_to(&escrow_id, &dest, &approvals).is_err());
    assert_eq!(source.get_status(&escrow_id), EscrowStatus::Funded);

    env.mock_auths(&[MockAuth {
        address: &payer,
        invoke: &invoke,
    }]);
    assert!(source.try_export_to(&escrow_id, &dest, &approvals).is_err());
    assert_eq!(source.get_status(&escrow_id), EscrowStatus::Funded);

    env.mock_auths(&[
        MockAuth {
            address: &payer,
            invoke: &invoke,
        },
        MockAuth {
            address: &first,
            invoke: &invoke,
        },
    ]);
    assert!(source.try_export_to(&escrow_id, &dest, &approvals).is_err());
    assert_eq!(source.get_status(&escrow_id), EscrowStatus::Funded);

    env.mock_auths(&[
        MockAuth {
            address: &payer,
            invoke: &invoke,
        },
        MockAuth {
            address: &first,
            invoke: &invoke,
        },
        MockAuth {
            address: &second,
            invoke: &invoke,
        },
    ]);
    source.export_to(&escrow_id, &dest, &approvals);
    assert_eq!(source.get_status(&escrow_id), EscrowStatus::Migrated);
}

#[test]
fn unrecognized_source_contract_is_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let (token_id, _token, asset) = setup(&env);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    let src = env.register(EscrowContract, (Vec::<Address>::new(&env), Vec::<Address>::new(&env)));
    let dest = env.register(EscrowContract, (Vec::<Address>::new(&env), Vec::<Address>::new(&env)));
    let source = EscrowContractClient::new(&env, &src);
    asset.mint(&payer, &1_000);
    let escrow_id = source.create_escrow(
        &payer,
        &payee,
        &token_id,
        &250,
        &String::from_str(&env, "ref"),
        &releaser,
        &None,
        &false,
        &None,
    );

    let approvals = Vec::from_array(&env, [releaser]);
    let result = source.try_export_to(&escrow_id, &dest, &approvals);
    assert!(result.is_err());
    assert_eq!(source.get_status(&escrow_id), EscrowStatus::Funded);
}

#[test]
fn destination_token_allowlist_rejection_rolls_back_the_transfer() {
    let env = Env::default();
    env.mock_all_auths();

    let (token_id, token, asset) = setup(&env);
    let (_, other_token, _) = setup(&env);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    let src = env.register(EscrowContract, (Vec::<Address>::new(&env), Vec::<Address>::new(&env)));
    let dest = env.register(
        EscrowContract,
        (Vec::from_array(&env, [other_token.address.clone()]), Vec::from_array(&env, [src.clone()])),
    );
    let source = EscrowContractClient::new(&env, &src);
    asset.mint(&payer, &1_000);
    let escrow_id = source.create_escrow(
        &payer,
        &payee,
        &token_id,
        &200,
        &String::from_str(&env, "rejected-token"),
        &releaser,
        &None,
        &false,
        &None,
    );

    let approvals = Vec::from_array(&env, [releaser]);
    assert!(source.try_export_to(&escrow_id, &dest, &approvals).is_err());
    assert_eq!(source.get_status(&escrow_id), EscrowStatus::Funded);
    assert_eq!(token.balance(&src), 200);
    assert_eq!(token.balance(&dest), 0);
}

#[test]
fn forged_import_from_an_unapproved_contract_is_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let (_, _token, _asset) = setup(&env);
    let source = Address::generate(&env);
    let dest = env.register(EscrowContract, (Vec::<Address>::new(&env), Vec::<Address>::new(&env)));
    let dest_client = EscrowContractClient::new(&env, &dest);
    let payload = MigrationData {
        source_contract: source.clone(),
        escrow_id: 5,
        destination_balance_before: 0,
        payer: Address::generate(&env),
        payee: Address::generate(&env),
        token: Address::generate(&env),
        amount: 10,
        condition_ref: String::from_str(&env, "forged"),
        status: EscrowStatus::Funded,
        releasers: Vec::from_array(&env, [Address::generate(&env)]),
        threshold: 1,
        refund_after: None,
        notify_payee: false,
        requires_acceptance: false,
        accepted_at: None,
        refund_to: Address::generate(&env),
    };

    let result = dest_client.try_import_from(&source, &payload);
    assert!(result.is_err());
    assert!(matches!(
        dest_client.try_get_status(&0),
        Err(Ok(docforum_escrow::Error::NotFound))
    ));
}

#[test]
fn duplicate_migration_is_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let (token_id, _token, asset) = setup(&env);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    let src = env.register(EscrowContract, (Vec::<Address>::new(&env), Vec::<Address>::new(&env)));
    let dest = env.register(EscrowContract, (Vec::<Address>::new(&env), Vec::from_array(&env, [src.clone()])));
    let source = EscrowContractClient::new(&env, &src);
    let dest_client = EscrowContractClient::new(&env, &dest);
    asset.mint(&payer, &1_000);

    let escrow_id = source.create_escrow(
        &payer,
        &payee,
        &token_id,
        &150,
        &String::from_str(&env, "ref"),
        &releaser,
        &None,
        &false,
        &None,
    );

    let approvals = Vec::from_array(&env, [releaser]);
    source.export_to(&escrow_id, &dest, &approvals);
    let second = source.try_export_to(&escrow_id, &dest, &approvals);
    assert!(second.is_err());
    assert_eq!(dest_client.get_status(&0), EscrowStatus::Funded);
}

#[test]
fn id_collisions_across_sources_do_not_overlap() {
    let env = Env::default();
    env.mock_all_auths();

    let (token_id, _token, asset) = setup(&env);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    let src_a = env.register(EscrowContract, (Vec::<Address>::new(&env), Vec::<Address>::new(&env)));
    let src_b = env.register(EscrowContract, (Vec::<Address>::new(&env), Vec::<Address>::new(&env)));
    let dest = env.register(
        EscrowContract,
        (Vec::<Address>::new(&env), Vec::from_array(&env, [src_a.clone(), src_b.clone()])),
    );
    let client_a = EscrowContractClient::new(&env, &src_a);
    let client_b = EscrowContractClient::new(&env, &src_b);
    let dest_client = EscrowContractClient::new(&env, &dest);
    asset.mint(&payer, &1_000);

    let first_id = client_a.create_escrow(
        &payer,
        &payee,
        &token_id,
        &100,
        &String::from_str(&env, "a"),
        &releaser,
        &None,
        &false,
        &None,
    );
    let second_id = client_b.create_escrow(
        &payer,
        &payee,
        &token_id,
        &75,
        &String::from_str(&env, "b"),
        &releaser,
        &None,
        &false,
        &None,
    );

    assert_eq!(first_id, 0);
    assert_eq!(second_id, 0);
    let approvals = Vec::from_array(&env, [releaser]);
    client_a.export_to(&first_id, &dest, &approvals);
    client_b.export_to(&second_id, &dest, &approvals);
    assert_eq!(dest_client.get_status(&0), EscrowStatus::Funded);
    assert_eq!(dest_client.get_status(&1), EscrowStatus::Funded);
}

#[test]
fn source_escrow_cannot_release_or_refund_after_migration() {
    let env = Env::default();
    env.mock_all_auths();

    let (token_id, _token, asset) = setup(&env);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    let src = env.register(EscrowContract, (Vec::<Address>::new(&env), Vec::from_array(&env, [Address::generate(&env)])));
    let dest = env.register(EscrowContract, (Vec::<Address>::new(&env), Vec::from_array(&env, [src.clone()])));
    asset.mint(&payer, &1_000);
    let client = EscrowContractClient::new(&env, &src);
    let escrow = client.create_escrow(
        &payer,
        &payee,
        &token_id,
        &200,
        &String::from_str(&env, "check"),
        &releaser,
        &None,
        &false,
        &None,
    );

    let approvals = Vec::from_array(&env, [releaser.clone()]);
    client.export_to(&escrow, &dest, &approvals);
    assert!(client.try_release(&escrow, &releaser).is_err());
    assert!(client.try_refund(&escrow, &releaser).is_err());
}
