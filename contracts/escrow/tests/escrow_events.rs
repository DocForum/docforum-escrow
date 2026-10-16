use docforum_escrow::{
    EscrowContract, EscrowContractClient, EscrowCreated, EscrowRefunded, EscrowReleased,
    EscrowStatus,
};
use soroban_sdk::{
    testutils::{Address as _, Events as _},
    token::{StellarAssetClient, TokenClient},
    Address, Env, Event, String,
};

#[test]
fn lifecycle_events_include_address_index_and_reconstruction_data() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(admin).address();
    let _token = TokenClient::new(&env, &token_id);
    let asset = StellarAssetClient::new(&env, &token_id);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    asset.mint(&payer, &500);

    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);
    let condition_ref = String::from_str(&env, "invoice-123");
    let escrow_id = client.create_escrow(
        &payer,
        &payee,
        &token_id,
        &300,
        &condition_ref,
        &releaser,
        &None,
    );
    let created = EscrowCreated {
        escrow_id,
        payer: payer.clone(),
        payee: payee.clone(),
        token: token_id.clone(),
        amount: 300,
        condition_ref,
        releaser: releaser.clone(),
        refund_after: None,
    };
    let events = env.events().all().filter_by_contract(&contract_id);
    assert_eq!(events, std::vec![created.to_xdr(&env, &contract_id)]);

    client.release(&escrow_id, &releaser);
    let released = EscrowReleased {
        escrow_id,
        payer: payer.clone(),
        payee: payee.clone(),
        token: token_id.clone(),
        amount: 300,
    };
    let events = env.events().all().filter_by_contract(&contract_id);
    assert_eq!(events, std::vec![released.to_xdr(&env, &contract_id)]);
    assert_eq!(client.get_status(&escrow_id), EscrowStatus::Released);

    // A second escrow exercises the refund event and proves index consumers
    // receive the same payer/payee/token/amount shape for both terminal paths.
    let second_id = client.create_escrow(
        &payer,
        &payee,
        &token_id,
        &200,
        &String::from_str(&env, "invoice-456"),
        &releaser,
        &None,
    );
    assert_eq!(
        env.events()
            .all()
            .filter_by_contract(&contract_id)
            .events()
            .len(),
        1
    );
    client.refund(&second_id, &releaser);
    let events = env.events().all().filter_by_contract(&contract_id);
    let refunded = EscrowRefunded {
        escrow_id: second_id,
        payer,
        payee,
        token: token_id,
        amount: 200,
    };
    assert_eq!(events, std::vec![refunded.to_xdr(&env, &contract_id)]);
}
