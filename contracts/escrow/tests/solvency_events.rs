use docforum_escrow::{
    EscrowContract, EscrowContractClient, EscrowCreated, EscrowRefunded, EscrowReleased,
};
use soroban_sdk::{
    testutils::{Address as _, Events as _},
    token::{StellarAssetClient, TokenClient},
    Address, Env, Event, String, Vec,
};

#[test]
fn lifecycle_events_include_token_and_amount_for_reconciliation() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(admin).address();
    let _token = TokenClient::new(&env, &token_id);
    let asset = StellarAssetClient::new(&env, &token_id);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    asset.mint(&payer, &1_000);

    let contract_id = env.register(EscrowContract, (Vec::<Address>::new(&env),));
    let client = EscrowContractClient::new(&env, &contract_id);
    let id = client.create_escrow(
        &payer,
        &payee,
        &token_id,
        &700,
        &String::from_str(&env, "fixture-escrow"),
        &releaser,
        &None,
    );
    let created = EscrowCreated {
        escrow_id: id,
        payer: payer.clone(),
        payee: payee.clone(),
        token: token_id.clone(),
        amount: 700,
        condition_ref: String::from_str(&env, "fixture-escrow"),
        releaser: releaser.clone(),
        refund_after: None,
    };
    assert_eq!(
        env.events().all().filter_by_contract(&contract_id),
        std::vec![created.to_xdr(&env, &contract_id)],
    );

    client.release(&id, &releaser);
    let released = EscrowReleased {
        escrow_id: id,
        payer: payer.clone(),
        payee: payee.clone(),
        token: token_id.clone(),
        amount: 700,
    };
    assert_eq!(
        env.events().all().filter_by_contract(&contract_id),
        std::vec![released.to_xdr(&env, &contract_id)],
    );

    let refund_id = client.create_escrow(
        &payer,
        &payee,
        &token_id,
        &200,
        &String::from_str(&env, "fixture-refund"),
        &releaser,
        &None,
    );
    client.refund(&refund_id, &releaser);
    let refunded = EscrowRefunded {
        escrow_id: refund_id,
        payer,
        payee,
        token: token_id,
        amount: 200,
    };
    assert_eq!(
        env.events().all().filter_by_contract(&contract_id),
        std::vec![refunded.to_xdr(&env, &contract_id)],
    );
}
