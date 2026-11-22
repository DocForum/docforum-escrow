// Phase E5 issue #117: migration is a source-to-target contract call. The
// target trusts source addresses fixed at construction, while payer and the
// single releaser authorize the source export.

use docforum_escrow::{Error, EscrowContract, EscrowContractClient, EscrowStatus};
use soroban_sdk::{
    testutils::Address as _, token::{StellarAssetClient, TokenClient}, Address, Env, String, Vec,
};

fn setup(env: &Env) -> (Address, TokenClient<'_>, StellarAssetClient<'_>) {
    let admin = Address::generate(env);
    let token_id = env.register_stellar_asset_contract_v2(admin);
    (
        token_id.address(),
        TokenClient::new(env, &token_id.address()),
        StellarAssetClient::new(env, &token_id.address()),
    )
}

#[test]
fn migrates_funded_escrow_and_moves_funds_atomically() {
    let env = Env::default();
    env.mock_all_auths();
    let (token_id, token, asset) = setup(&env);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    asset.mint(&payer, &1_000);

    let source = env.register(EscrowContract, (Vec::<Address>::new(&env), Vec::<Address>::new(&env)));
    let mut trusted = Vec::new(&env);
    trusted.push_back(source.clone());
    let target = env.register(EscrowContract, (Vec::<Address>::new(&env), trusted));
    let source_client = EscrowContractClient::new(&env, &source);
    let target_client = EscrowContractClient::new(&env, &target);

    let old_id = source_client.create_escrow(
        &payer, &payee, &token_id, &300, &String::from_str(&env, "migration-ref"),
        &releaser, &None, &false, &None,
    );
    let new_id = source_client.export_to(&old_id, &target, &payer, &releaser);

    assert_eq!(source_client.get_status(&old_id), EscrowStatus::Migrated);
    assert_eq!(target_client.get_status(&new_id), EscrowStatus::Funded);
    assert_eq!(target_client.get_escrow(&new_id).condition_ref, String::from_str(&env, "migration-ref"));
    assert_eq!(token.balance(&source), 0);
    assert_eq!(token.balance(&target), 300);
}

#[test]
fn rejects_export_when_target_does_not_trust_source_and_leaves_source_intact() {
    let env = Env::default();
    env.mock_all_auths();
    let (token_id, token, asset) = setup(&env);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    asset.mint(&payer, &1_000);

    let source = env.register(EscrowContract, (Vec::<Address>::new(&env), Vec::<Address>::new(&env)));
    let target = env.register(EscrowContract, (Vec::<Address>::new(&env), Vec::<Address>::new(&env)));
    let source_client = EscrowContractClient::new(&env, &source);
    let target_client = EscrowContractClient::new(&env, &target);
    let old_id = source_client.create_escrow(
        &payer, &payee, &token_id, &300, &String::from_str(&env, "untrusted-source"),
        &releaser, &None, &false, &None,
    );

    let result = source_client.try_export_to(&old_id, &target, &payer, &releaser);
    assert_eq!(result, Err(Ok(Error::UntrustedMigrationSource)));
    assert_eq!(source_client.get_status(&old_id), EscrowStatus::Funded);
    assert_eq!(token.balance(&source), 300);
    assert_eq!(target_client.try_get_status(&0), Err(Ok(Error::NotFound)));
}

