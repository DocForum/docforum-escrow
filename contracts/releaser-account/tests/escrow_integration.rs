use docforum_escrow::{EscrowContract, EscrowContractClient, EscrowStatus};
use docforum_releaser_account::{ReleaserAccount, ReleaserAccountClient};
use soroban_sdk::{
    testutils::{Address as _, MockAuth, MockAuthInvoke},
    token, Address, Env, IntoVal, String, Vec,
};

#[test]
fn custom_account_can_be_configured_as_escrow_releaser() {
    let env = Env::default();
    env.mock_all_auths();

    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token = token::StellarAssetClient::new(&env, &token_id.address());
    let token_client = token::Client::new(&env, &token_id.address());
    token.mint(&payer, &500);

    let escrow_id = env.register(
        EscrowContract,
        (Vec::<Address>::new(&env), Address::generate(&env)),
    );
    let escrow = EscrowContractClient::new(&env, &escrow_id);
    let signer_key = soroban_sdk::BytesN::from_array(&env, &[7; 32]);
    let signers: Vec<soroban_sdk::BytesN<32>> = Vec::from_array(&env, [signer_key]);
    let releaser_id = env.register(
        ReleaserAccount,
        (&escrow_id, &signers, &1u32, &3u32, &10u32),
    );
    let id = escrow.create_escrow(
        &payer,
        &payee,
        &token_id.address(),
        &250,
        &String::from_str(&env, "contract account test"),
        &releaser_id,
        &None,
        &false,
        &None,
        &None,
        &None,
    );
    let replacement = Address::generate(&env);
    let rotate = MockAuthInvoke {
        contract: &escrow_id,
        fn_name: "rotate_releaser",
        args: (id.clone(), releaser_id.clone(), replacement.clone()).into_val(&env),
        sub_invokes: &[],
    };
    // Rotation requires both the custom releaser account and the payer.
    env.mock_auths(&[
        MockAuth {
            address: &releaser_id,
            invoke: &rotate,
        },
        MockAuth {
            address: &payer,
            invoke: &rotate,
        },
    ]);
    escrow.rotate_releaser(&id, &releaser_id, &replacement);

    env.mock_all_auths();
    escrow.release(&id, &replacement);

    assert_eq!(token_client.balance(&payee), 250);
    assert_eq!(escrow.get_status(&id), EscrowStatus::Released);
}

#[test]
fn custom_account_can_be_one_member_of_a_quorum() {
    let env = Env::default();
    env.mock_all_auths();

    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(Address::generate(&env));
    let asset = token::StellarAssetClient::new(&env, &token_id.address());
    let token_client = token::Client::new(&env, &token_id.address());
    asset.mint(&payer, &500);

    let escrow_id = env.register(
        EscrowContract,
        (Vec::<Address>::new(&env), Address::generate(&env)),
    );
    let escrow = EscrowContractClient::new(&env, &escrow_id);
    let signer_key = soroban_sdk::BytesN::from_array(&env, &[8; 32]);
    let signers: Vec<soroban_sdk::BytesN<32>> = Vec::from_array(&env, [signer_key]);
    let account = env.register(
        ReleaserAccount,
        (&escrow_id, &signers, &1u32, &3u32, &10u32),
    );
    let plain_releaser = Address::generate(&env);
    let third_releaser = Address::generate(&env);
    let releasers = Vec::from_array(
        &env,
        [account.clone(), plain_releaser.clone(), third_releaser],
    );
    let id = escrow.create_escrow_with_releasers(
        &payer,
        &payee,
        &token_id.address(),
        &250,
        &String::from_str(&env, "mixed quorum test"),
        &releasers,
        &2,
        &None,
        &false,
        &None,
    );

    let approvers = Vec::from_array(&env, [account, plain_releaser]);
    escrow.release_with_approvals(&id, &approvers);

    assert_eq!(token_client.balance(&payee), 250);
    assert_eq!(escrow.get_status(&id), EscrowStatus::Released);
}

#[test]
fn custom_account_can_authorize_settle_many() {
    let env = Env::default();
    env.mock_all_auths();

    let payer = Address::generate(&env);
    let payee1 = Address::generate(&env);
    let payee2 = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(token_admin);
    let token = token::StellarAssetClient::new(&env, &token_id.address());
    let token_client = token::Client::new(&env, &token_id.address());
    token.mint(&payer, &1000);

    let escrow_id = env.register(
        EscrowContract,
        (Vec::<Address>::new(&env), Address::generate(&env)),
    );
    let escrow = EscrowContractClient::new(&env, &escrow_id);
    let signer_key = soroban_sdk::BytesN::from_array(&env, &[7; 32]);
    let signers: Vec<soroban_sdk::BytesN<32>> = Vec::from_array(&env, [signer_key]);
    let releaser_id = env.register(
        ReleaserAccount,
        (&escrow_id, &signers, &1u32, &10u32, &10u32),
    );
    let releaser = ReleaserAccountClient::new(&env, &releaser_id);

    let id1 = escrow.create_escrow(
        &payer,
        &payee1,
        &token_id.address(),
        &200,
        &String::from_str(&env, "batch test 1"),
        &releaser_id,
        &None,
        &false,
        &None,
        &None,
        &None,
    );
    let id2 = escrow.create_escrow(
        &payer,
        &payee2,
        &token_id.address(),
        &300,
        &String::from_str(&env, "batch test 2"),
        &releaser_id,
        &None,
        &false,
        &None,
        &None,
        &None,
    );

    let ops = soroban_sdk::vec![
        &env,
        (id1, docforum_escrow::SettleAction::Release),
        (id2, docforum_escrow::SettleAction::Refund),
    ];

    let results = escrow.settle_many(&releaser_id, &ops);
    assert_eq!(results.len(), 2);
    assert_eq!(token_client.balance(&payee1), 200);
    assert_eq!(token_client.balance(&payer), 800);
    assert_eq!(releaser.escrow(), escrow_id);
}
