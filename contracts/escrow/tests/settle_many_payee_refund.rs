use docforum_escrow::{
    EscrowContract, EscrowContractClient, EscrowStatus, PayeeRefunded, SettleAction,
};
use soroban_sdk::{
    testutils::{Address as _, Events as _},
    Address, Env, Event, String, Vec,
};

#[test]
fn settle_many_accepts_payee_voluntary_refund_and_emits_payee_event() {
    let env = Env::default();
    env.mock_all_auths();
    let token_id = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    soroban_sdk::token::StellarAssetClient::new(&env, &token_id).mint(&payer, &100);
    let contract_id = env.register(
        EscrowContract,
        (Vec::<Address>::new(&env), Address::generate(&env)),
    );
    let client = EscrowContractClient::new(&env, &contract_id);
    let escrow_id = client.create_escrow(
        &payer,
        &payee,
        &token_id,
        &100,
        &String::from_str(&env, "settle-many-payee-refund"),
        &releaser,
        &None,
        &false,
        &None,
        &None,
        &None,
    );
    let mut ops = Vec::new(&env);
    ops.push_back((escrow_id, SettleAction::Refund));

    let results = client.settle_many(&payee, &ops);

    assert_eq!(results.len(), 1);
    assert!(results.get(0).unwrap().is_ok());
    let expected = PayeeRefunded {
        escrow_id,
        payer: payer.clone(),
        payee: payee.clone(),
        amount: 100,
    };
    let contract_events = env.events().all().filter_by_contract(&contract_id);
    let events = contract_events.events();
    assert_eq!(events.len(), 2);
    assert_eq!(events[1], expected.to_xdr(&env, &contract_id));
    assert_eq!(client.get_status(&escrow_id), EscrowStatus::Refunded);
    assert_eq!(soroban_sdk::token::TokenClient::new(&env, &token_id).balance(&payer), 100);
}
