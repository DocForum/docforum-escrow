use docforum_escrow::{EscrowContract, EscrowContractClient, EscrowStatus};
use ed25519_dalek::{Signer, SigningKey};
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    Address, BytesN, Env, String,
};

fn create_escrow<'a>(
    env: &'a Env,
    client: &EscrowContractClient<'a>,
    token_id: &Address,
    payer: &Address,
    payee: &Address,
    releaser: &Address,
    attester: &BytesN<32>,
) -> u64 {
    client.create_escrow(
        payer,
        payee,
        token_id,
        &100,
        &String::from_str(env, "attested-invoice"),
        releaser,
        &None,
        &Some(attester.clone()),
    )
}

#[test]
fn configured_attester_can_release_once_with_valid_signature() {
    let env = Env::default();
    env.mock_all_auths();
    let signing_key = SigningKey::from_bytes(&[42; 32]);
    let public_key = BytesN::from_array(&env, &signing_key.verifying_key().to_bytes());
    let admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(admin).address();
    let token = TokenClient::new(&env, &token_id);
    let asset = StellarAssetClient::new(&env, &token_id);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    asset.mint(&payer, &500);
    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);
    let escrow_id = create_escrow(
        &env,
        &client,
        &token_id,
        &payer,
        &payee,
        &releaser,
        &public_key,
    );

    let payload = client.release_attestation_payload(&escrow_id);
    let signature = BytesN::from_array(&env, &signing_key.sign(&payload.to_array()).to_bytes());
    client.release_with_attestation(&escrow_id, &signature);

    assert_eq!(client.get_status(&escrow_id), EscrowStatus::Released);
    assert_eq!(token.balance(&payee), 100);
    assert!(client
        .try_release_with_attestation(&escrow_id, &signature)
        .is_err());
    assert_eq!(token.balance(&payee), 100);
}

#[test]
fn attestation_cannot_be_replayed_on_another_contract_or_network() {
    let env = Env::default();
    env.mock_all_auths();
    let signing_key = SigningKey::from_bytes(&[43; 32]);
    let public_key = BytesN::from_array(&env, &signing_key.verifying_key().to_bytes());
    let admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(admin).address();
    let asset = StellarAssetClient::new(&env, &token_id);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    asset.mint(&payer, &500);

    let first_id = env.register(EscrowContract, ());
    let first = EscrowContractClient::new(&env, &first_id);
    let second_id = env.register(EscrowContract, ());
    let second = EscrowContractClient::new(&env, &second_id);
    let first_escrow = create_escrow(
        &env,
        &first,
        &token_id,
        &payer,
        &payee,
        &releaser,
        &public_key,
    );
    let second_escrow = create_escrow(
        &env,
        &second,
        &token_id,
        &payer,
        &payee,
        &releaser,
        &public_key,
    );
    assert_eq!(first_escrow, second_escrow);
    let first_payload = first.release_attestation_payload(&first_escrow);
    let signature = BytesN::from_array(
        &env,
        &signing_key.sign(&first_payload.to_array()).to_bytes(),
    );

    assert!(second
        .try_release_with_attestation(&second_escrow, &signature)
        .is_err());

    let original_network = env.ledger().network_id().to_array();
    env.ledger().set_network_id([99; 32]);
    assert!(first
        .try_release_with_attestation(&first_escrow, &signature)
        .is_err());
    env.ledger().set_network_id(original_network);
    assert_eq!(first.get_status(&first_escrow), EscrowStatus::Funded);
}
