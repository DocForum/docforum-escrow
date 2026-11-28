use docforum_escrow::{Error, EscrowContract, EscrowContractClient, EscrowStatus, PayeeShare};
use soroban_sdk::{
    testutils::Address as _,
    token::{StellarAssetClient, TokenClient},
    Address, Env, String, Vec,
};

fn setup<'a>(env: &Env) -> (EscrowContractClient<'a>, TokenClient<'a>, Address, Address) {
    let admin = Address::generate(env);
    let token_id = env.register_stellar_asset_contract_v2(admin);
    let token = TokenClient::new(env, &token_id.address());
    let asset = StellarAssetClient::new(env, &token_id.address());
    let payer = Address::generate(env);
    asset.mint(&payer, &1_000);
    let contract_id = env.register(
        EscrowContract,
        (Vec::<Address>::new(env), Address::generate(env)),
    );
    (
        EscrowContractClient::new(env, &contract_id),
        token,
        token_id.address(),
        payer,
    )
}

fn share(_env: &Env, payee: &Address, basis_points: u32) -> PayeeShare {
    PayeeShare {
        payee: payee.clone(),
        basis_points,
    }
}

#[test]
fn split_release_assigns_rounding_dust_to_last_recipient_and_exposes_splits() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, token, token_id, payer) = setup(&env);
    let releaser = Address::generate(&env);
    let first = Address::generate(&env);
    let second = Address::generate(&env);
    let last = Address::generate(&env);
    let mut payees = Vec::new(&env);
    payees.push_back(share(&env, &first, 3_333));
    payees.push_back(share(&env, &second, 3_333));
    payees.push_back(share(&env, &last, 3_334));

    let id = client.create_split_escrow(
        &payer,
        &payees,
        &token_id,
        &10,
        &String::from_str(&env, "order-1"),
        &releaser,
        &None,
        &false,
        &None,
        &None,
        &None,
    );

    let stored = client.get_escrow(&id);
    assert_eq!(stored.payees.len(), 3);
    assert_eq!(stored.payee, first);
    client.release(&id, &releaser);
    assert_eq!(token.balance(&first), 3);
    assert_eq!(token.balance(&second), 3);
    assert_eq!(token.balance(&last), 4);
    assert_eq!(
        token.balance(&first) + token.balance(&second) + token.balance(&last),
        10
    );
    assert_eq!(client.get_status(&id), EscrowStatus::Released);
}

#[test]
fn one_payee_api_is_stored_as_a_full_share() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _token, token_id, payer) = setup(&env);
    let releaser = Address::generate(&env);
    let payee = Address::generate(&env);
    let id = client.create_escrow(
        &payer,
        &payee,
        &token_id,
        &1,
        &String::from_str(&env, "order-2"),
        &releaser,
        &None,
        &false,
        &None,
        &None,
        &None,
    );
    let stored = client.get_escrow(&id);
    assert_eq!(stored.payees.len(), 1);
    assert_eq!(
        stored.payees.get(0).map(|share| share.basis_points),
        Some(10_000)
    );
}

#[test]
fn split_creation_rejects_invalid_totals_and_duplicate_recipients() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _token, token_id, payer) = setup(&env);
    let releaser = Address::generate(&env);
    let recipient = Address::generate(&env);
    let mut bad_total = Vec::new(&env);
    bad_total.push_back(share(&env, &recipient, 9_999));
    assert!(client
        .try_create_split_escrow(
            &payer,
            &bad_total,
            &token_id,
            &1,
            &String::from_str(&env, "bad-total"),
            &releaser,
            &None,
            &false,
            &None,
            &None,
            &None,
        )
        .is_err());

    let mut duplicate = Vec::new(&env);
    duplicate.push_back(share(&env, &recipient, 5_000));
    duplicate.push_back(share(&env, &recipient, 5_000));
    assert!(client
        .try_create_split_escrow(
            &payer,
            &duplicate,
            &token_id,
            &1,
            &String::from_str(&env, "duplicate"),
            &releaser,
            &None,
            &false,
            &None,
            &None,
            &None,
        )
        .is_err());
}

#[test]
fn split_release_deducts_fee_before_distributing_the_net() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, token, token_id, payer) = setup(&env);
    let releaser = Address::generate(&env);
    let first = Address::generate(&env);
    let second = Address::generate(&env);
    let fee_recipient = Address::generate(&env);
    let mut payees = Vec::new(&env);
    payees.push_back(share(&env, &first, 5_000));
    payees.push_back(share(&env, &second, 5_000));

    let id = client.create_split_escrow(
        &payer,
        &payees,
        &token_id,
        &100,
        &String::from_str(&env, "fee-split"),
        &releaser,
        &None,
        &false,
        &None,
        &Some(fee_recipient.clone()),
        &Some(1_000),
    );
    client.release(&id, &releaser);

    assert_eq!(token.balance(&fee_recipient), 10);
    assert_eq!(token.balance(&first), 45);
    assert_eq!(token.balance(&second), 45);
}

#[test]
fn split_creation_rejects_more_than_eight_recipients() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _token, token_id, payer) = setup(&env);
    let releaser = Address::generate(&env);
    let mut payees = Vec::new(&env);
    for index in 0..9 {
        let bps = if index == 8 { 1_112 } else { 1_111 };
        payees.push_back(share(&env, &Address::generate(&env), bps));
    }

    let result = client.try_create_split_escrow(
        &payer,
        &payees,
        &token_id,
        &100,
        &String::from_str(&env, "too-many-payees"),
        &releaser,
        &None,
        &false,
        &None,
        &None,
        &None,
    );
    assert_eq!(result, Err(Ok(Error::TooManyPayees)));
}

/// Golden sweep for the split-payout arithmetic (Scout triage): for small
/// amounts and rounding boundaries, with a 2.5 % fee and an uneven three-way split, the
/// fee and each non-final share are exactly `floor(x * bps / 10 000)` and the
/// final payee gets the remainder, so the four transfers always sum to the
/// escrowed amount and the contract keeps nothing.
#[test]
fn split_release_amounts_match_the_direct_formula_across_a_sweep() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, token, token_id, payer) = setup(&env);
    StellarAssetClient::new(&env, &token_id).mint(&payer, &1_000);
    let releaser = Address::generate(&env);
    let first = Address::generate(&env);
    let second = Address::generate(&env);
    let last = Address::generate(&env);
    let fee_recipient = Address::generate(&env);
    let mut payees = Vec::new(&env);
    payees.push_back(share(&env, &first, 2_500));
    payees.push_back(share(&env, &second, 3_333));
    payees.push_back(share(&env, &last, 4_167));

    for amount in [1i128, 2, 3, 4, 7, 9, 10, 39, 40, 41, 97, 100] {
        let before = [
            token.balance(&fee_recipient),
            token.balance(&first),
            token.balance(&second),
            token.balance(&last),
        ];
        let id = client.create_split_escrow(
            &payer,
            &payees,
            &token_id,
            &amount,
            &String::from_str(&env, "sweep"),
            &releaser,
            &None,
            &false,
            &None,
            &Some(fee_recipient.clone()),
            &Some(250),
        );
        client.release(&id, &releaser);

        let fee = amount * 250 / 10_000;
        let net = amount - fee;
        let first_share = net * 2_500 / 10_000;
        let second_share = net * 3_333 / 10_000;
        let last_share = net - first_share - second_share;
        assert_eq!(
            token.balance(&fee_recipient) - before[0],
            fee,
            "amount {amount}"
        );
        assert_eq!(
            token.balance(&first) - before[1],
            first_share,
            "amount {amount}"
        );
        assert_eq!(
            token.balance(&second) - before[2],
            second_share,
            "amount {amount}"
        );
        assert_eq!(
            token.balance(&last) - before[3],
            last_share,
            "amount {amount}"
        );
        assert_eq!(token.balance(&client.address), 0, "amount {amount}");
    }
}
