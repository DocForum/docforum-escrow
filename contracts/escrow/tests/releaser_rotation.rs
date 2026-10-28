use docforum_escrow::{EscrowContract, EscrowContractClient};
use soroban_sdk::{
    testutils::{Address as _, MockAuth, MockAuthInvoke},
    token::{StellarAssetClient, TokenClient},
    Address, Env, IntoVal, String, Vec,
};

fn funded_escrow(
    env: &Env,
) -> (
    EscrowContractClient<'_>,
    TokenClient<'_>,
    Address,
    Address,
    Address,
    u64,
) {
    let admin = Address::generate(env);
    let token_id = env.register_stellar_asset_contract_v2(admin);
    let token = TokenClient::new(env, &token_id.address());
    let asset = StellarAssetClient::new(env, &token_id.address());
    let payer = Address::generate(env);
    let payee = Address::generate(env);
    let releaser = Address::generate(env);
    asset.mint(&payer, &1_000);

    let contract_id = env.register(EscrowContract, (Vec::<Address>::new(env),));
    let client = EscrowContractClient::new(env, &contract_id);
    let id = client.create_escrow(
        &payer,
        &payee,
        &token_id.address(),
        &300,
        &String::from_str(env, "rotation-test"),
        &releaser,
        &None,
        &false,
        &None,
        &None,
        &None,
    );
    (client, token, payer, payee, releaser, id)
}

#[test]
fn rotation_requires_both_stored_parties_and_updates_the_releaser() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _token, payer, _payee, old_releaser, id) = funded_escrow(&env);
    let replacement = Address::generate(&env);

    let invoke = MockAuthInvoke {
        contract: &client.address,
        fn_name: "rotate_releaser",
        args: (id.clone(), old_releaser.clone(), replacement.clone()).into_val(&env),
        sub_invokes: &[],
    };

    // A releaser signature alone cannot rotate the role.
    env.mock_auths(&[MockAuth {
        address: &old_releaser,
        invoke: &invoke,
    }]);
    assert!(client
        .try_rotate_releaser(&id, &old_releaser, &replacement)
        .is_err());

    // A payer signature alone cannot invoke the operation either.
    env.mock_auths(&[MockAuth {
        address: &payer,
        invoke: &invoke,
    }]);
    assert!(client
        .try_rotate_releaser(&id, &old_releaser, &replacement)
        .is_err());

    env.mock_auths(&[
        MockAuth {
            address: &old_releaser,
            invoke: &invoke,
        },
        MockAuth {
            address: &payer,
            invoke: &invoke,
        },
    ]);

    client.rotate_releaser(&id, &old_releaser, &replacement);

    assert_eq!(client.get_escrow(&id).releasers.get(0), Some(replacement));
    assert!(client.try_release(&id, &old_releaser).is_err());
}

#[test]
fn rotation_rejects_wrong_releaser_and_non_funded_escrows() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _token, _payer, _payee, old_releaser, id) = funded_escrow(&env);
    let replacement = Address::generate(&env);
    let stranger = Address::generate(&env);

    assert!(client
        .try_rotate_releaser(&id, &stranger, &replacement)
        .is_err());
    client.release(&id, &old_releaser);
    assert!(client
        .try_rotate_releaser(&id, &old_releaser, &replacement)
        .is_err());
}

#[test]
fn rotation_rejects_contract_and_payee_as_new_releaser() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _token, _payer, payee, old_releaser, id) = funded_escrow(&env);
    let contract_address = client.address.clone();

    assert!(client
        .try_rotate_releaser(&id, &old_releaser, &payee)
        .is_err());
    assert!(client
        .try_rotate_releaser(&id, &old_releaser, &contract_address)
        .is_err());
}
