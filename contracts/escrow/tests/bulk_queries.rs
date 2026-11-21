use docforum_escrow::{EscrowContract, EscrowContractClient, EscrowStatus, Error, MAX_GET_ESCROWS};
use soroban_sdk::{testutils::Address as _, Address, Env, String, Vec};

#[test]
fn bulk_queries_return_records_unknowns_and_next_id() {
    let env = Env::default();
    env.mock_all_auths();
    let token = env.register_stellar_asset_contract_v2(Address::generate(&env)).address();
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    soroban_sdk::token::StellarAssetClient::new(&env, &token).mint(&payer, &100);
    let contract_id = env.register(
        EscrowContract,
        (Vec::<Address>::new(&env), Address::generate(&env)),
    );
    let client = EscrowContractClient::new(&env, &contract_id);
    assert_eq!(client.next_escrow_id(), 0);
    let id = client.create_escrow(
        &payer,
        &payee,
        &token,
        &100,
        &String::from_str(&env, "bulk-query"),
        &releaser,
        &None,
        &false,
        &None,
        &None,
        &None,
    );
    assert_eq!(client.next_escrow_id(), 1);
    let ids = soroban_sdk::vec![&env, id, 999];
    let records = client.get_escrows(&ids);
    assert_eq!(records.len(), 2);
    assert_eq!(records.get(0).unwrap().unwrap().status, EscrowStatus::Funded);
    assert!(records.get(1).unwrap().is_none());
}

#[test]
fn bulk_query_cap_is_enforced_before_reads() {
    let env = Env::default();
    env.mock_all_auths();
    let mut ids = Vec::new(&env);
    for id in 0..=MAX_GET_ESCROWS {
        ids.push_back(id as u64);
    }
    let contract_id = env.register(
        EscrowContract,
        (Vec::<Address>::new(&env), Address::generate(&env)),
    );
    let client = EscrowContractClient::new(&env, &contract_id);
    assert!(matches!(
        client.try_get_escrows(&ids),
        Err(Ok(Error::BatchTooLarge))
    ));
}
