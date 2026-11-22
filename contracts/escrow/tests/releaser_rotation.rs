use docforum_escrow::{Error, EscrowContract, EscrowContractClient, EscrowStatus};
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

    let contract_id = env.register(
        EscrowContract,
        (Vec::<Address>::new(env), Address::generate(env)),
    );
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

/// Creates a 2-of-3 quorum escrow (issue #294), mirroring
/// `tests/quorum.rs`. Returns the client, payer, payee, releaser set and
/// escrow id.
fn quorum_escrow(
    env: &Env,
) -> (
    EscrowContractClient<'_>,
    Address,
    Address,
    Vec<Address>,
    u64,
) {
    let token_id = env
        .register_stellar_asset_contract_v2(Address::generate(env))
        .address();
    let asset = StellarAssetClient::new(env, &token_id);
    let payer = Address::generate(env);
    let payee = Address::generate(env);
    asset.mint(&payer, &1_000);

    let contract_id = env.register(
        EscrowContract,
        (Vec::<Address>::new(env), Address::generate(env)),
    );
    let client = EscrowContractClient::new(env, &contract_id);
    let mut releasers = Vec::new(env);
    for _ in 0..3 {
        releasers.push_back(Address::generate(env));
    }
    let id = client.create_escrow_with_releasers(
        &payer,
        &payee,
        &token_id,
        &300,
        &String::from_str(env, "quorum-rotation-test"),
        &releasers,
        &2,
        &None,
        &false,
        &None,
    );
    (client, payer, payee, releasers, id)
}

fn approvers_of(env: &Env, set: &Vec<Address>, indexes: &[u32]) -> Vec<Address> {
    let mut out = Vec::new(env);
    for index in indexes {
        out.push_back(set.get(*index).unwrap());
    }
    out
}

#[test]
fn quorum_rotation_replaces_one_member_and_keeps_threshold() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _payer, _payee, releasers, id) = quorum_escrow(&env);
    let old = releasers.get(1).unwrap();
    let replacement = Address::generate(&env);
    let approvers = approvers_of(&env, &releasers, &[0, 2]);

    client.rotate_releaser_with_approvals(&id, &approvers, &old, &replacement);

    let data = client.get_escrow(&id);
    assert_eq!(data.status, EscrowStatus::Funded);
    assert_eq!(data.threshold, 2);
    assert_eq!(data.releasers.len(), 3);
    assert_eq!(data.releasers.get(0), Some(releasers.get(0).unwrap()));
    assert_eq!(data.releasers.get(1), Some(replacement.clone()));
    assert_eq!(data.releasers.get(2), Some(releasers.get(2).unwrap()));

    // The outgoing member can no longer settle.
    assert_eq!(
        client.try_release(&id, &old),
        Err(Ok(Error::Unauthorized))
    );
    // The replacement settles with one other member.
    let mut new_approvers = Vec::new(&env);
    new_approvers.push_back(replacement);
    new_approvers.push_back(releasers.get(0).unwrap());
    client.release_with_approvals(&id, &new_approvers);
}

#[test]
fn quorum_rotation_counts_the_outgoing_members_approval() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _payer, _payee, releasers, id) = quorum_escrow(&env);
    let old = releasers.get(0).unwrap();
    let replacement = Address::generate(&env);
    // The outgoing member is one of the two approvers.
    let approvers = approvers_of(&env, &releasers, &[0, 1]);

    client.rotate_releaser_with_approvals(&id, &approvers, &old, &replacement);

    assert_eq!(
        client.get_escrow(&id).releasers.get(0),
        Some(replacement)
    );
}

#[test]
fn quorum_rotation_rejects_bad_approvals_and_members() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _payer, payee, releasers, id) = quorum_escrow(&env);
    let old = releasers.get(0).unwrap();
    let replacement = Address::generate(&env);
    let stranger = Address::generate(&env);
    let contract_address = client.address.clone();

    // Fewer approvers than the threshold.
    let one = approvers_of(&env, &releasers, &[1]);
    assert_eq!(
        client.try_rotate_releaser_with_approvals(&id, &one, &old, &replacement),
        Err(Ok(Error::ThresholdNotMet))
    );
    // An approver who is not a member.
    let mut with_stranger = approvers_of(&env, &releasers, &[1]);
    with_stranger.push_back(stranger.clone());
    assert_eq!(
        client.try_rotate_releaser_with_approvals(&id, &with_stranger, &old, &replacement),
        Err(Ok(Error::Unauthorized))
    );
    // The same approver twice.
    let mut duplicate = approvers_of(&env, &releasers, &[1]);
    duplicate.push_back(releasers.get(1).unwrap());
    assert_eq!(
        client.try_rotate_releaser_with_approvals(&id, &duplicate, &old, &replacement),
        Err(Ok(Error::DuplicateApprover))
    );

    let approvers = approvers_of(&env, &releasers, &[1, 2]);
    // The replacement is already a member.
    assert_eq!(
        client.try_rotate_releaser_with_approvals(
            &id,
            &approvers,
            &old,
            &releasers.get(1).unwrap()
        ),
        Err(Ok(Error::InvalidReleaser))
    );
    // The replacement is the payee or the contract.
    assert_eq!(
        client.try_rotate_releaser_with_approvals(&id, &approvers, &old, &payee),
        Err(Ok(Error::InvalidReleaser))
    );
    assert_eq!(
        client.try_rotate_releaser_with_approvals(&id, &approvers, &old, &contract_address),
        Err(Ok(Error::InvalidReleaser))
    );
    // The outgoing address is not a member.
    assert_eq!(
        client.try_rotate_releaser_with_approvals(&id, &approvers, &stranger, &replacement),
        Err(Ok(Error::InvalidReleaser))
    );
}

#[test]
fn quorum_rotation_rejects_settled_escrows() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _payer, _payee, releasers, id) = quorum_escrow(&env);
    let approvers = approvers_of(&env, &releasers, &[0, 1]);
    client.release_with_approvals(&id, &approvers);
    let replacement = Address::generate(&env);

    assert_eq!(
        client.try_rotate_releaser_with_approvals(
            &id,
            &approvers,
            &releasers.get(0).unwrap(),
            &replacement
        ),
        Err(Ok(Error::NotFunded))
    );
}

#[test]
fn quorum_rotation_requires_payer_consent() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, payer, _payee, releasers, id) = quorum_escrow(&env);
    let old = releasers.get(0).unwrap();
    let replacement = Address::generate(&env);
    let approvers = approvers_of(&env, &releasers, &[1, 2]);

    let invoke = MockAuthInvoke {
        contract: &client.address,
        fn_name: "rotate_releaser_with_approvals",
        args: (id, approvers.clone(), old.clone(), replacement.clone()).into_val(&env),
        sub_invokes: &[],
    };

    // Approvers alone cannot rotate.
    env.mock_auths(&[
        MockAuth {
            address: &releasers.get(1).unwrap(),
            invoke: &invoke,
        },
        MockAuth {
            address: &releasers.get(2).unwrap(),
            invoke: &invoke,
        },
    ]);
    assert!(client
        .try_rotate_releaser_with_approvals(&id, &approvers, &old, &replacement)
        .is_err());

    // Approvers plus the payer can.
    env.mock_auths(&[
        MockAuth {
            address: &releasers.get(1).unwrap(),
            invoke: &invoke,
        },
        MockAuth {
            address: &releasers.get(2).unwrap(),
            invoke: &invoke,
        },
        MockAuth {
            address: &payer,
            invoke: &invoke,
        },
    ]);
    client.rotate_releaser_with_approvals(&id, &approvers, &old, &replacement);
    assert_eq!(
        client.get_escrow(&id).releasers.get(0),
        Some(replacement)
    );
}
