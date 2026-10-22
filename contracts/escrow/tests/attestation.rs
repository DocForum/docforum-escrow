// Attestation release tests (Phase E5, issue #75) — `release_with_attestation`.
//
// The attestation is an ed25519 signature by the escrow's single releaser
// account key over a canonical, domain-separated, network-bound message.
// These tests pin the message layout, prove a valid signature releases, and
// prove every binding element (network, contract, escrow id, action) is
// actually covered — a signature minted for one context must never settle
// another.

use docforum_escrow::{
    EscrowContract, EscrowContractClient, EscrowStatus, ATTESTATION_DOMAIN, Error as EscrowError,
};
use ed25519_dalek::{Signer, SigningKey};
use soroban_sdk::{
    address_payload::AddressPayload,
    testutils::{Address as _, Events as _, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    Address, BytesN, Env, String, Vec,
};

const NETWORK_ID: [u8; 32] = [7; 32];
const ACTION_RELEASE: &str = "release";

fn signing_key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

fn account_address(env: &Env, key: &SigningKey) -> Address {
    let public_key = BytesN::from_array(env, &key.verifying_key().to_bytes());
    Address::from_payload(env, AddressPayload::AccountIdPublicKeyEd25519(public_key))
}

fn message_bytes(
    env: &Env,
    client: &EscrowContractClient<'_>,
    escrow_id: u64,
    action: &str,
) -> std::vec::Vec<u8> {
    let message = client.attestation_message(&escrow_id, &String::from_str(env, action));
    let mut bytes = vec![0u8; message.len() as usize];
    message.copy_into_slice(&mut bytes);
    bytes
}

fn sign_message(env: &Env, key: &SigningKey, message: &[u8]) -> BytesN<64> {
    let mut bytes = [0u8; 64];
    bytes.copy_from_slice(&key.sign(message).to_bytes());
    BytesN::from_array(env, &bytes)
}

struct Fixture<'a> {
    client: EscrowContractClient<'a>,
    contract_id: Address,
    token: TokenClient<'a>,
    payee: Address,
    escrow_id: u64,
    attester: SigningKey,
}

/// One funded escrow whose single releaser is the `attester` account.
fn funded_escrow(env: &Env, attester_seed: u8) -> Fixture<'_> {
    env.mock_all_auths();
    env.ledger().set_network_id(NETWORK_ID);

    let admin = Address::generate(env);
    let token_id = env.register_stellar_asset_contract_v2(admin).address();
    let token = TokenClient::new(env, &token_id);
    let asset = StellarAssetClient::new(env, &token_id);

    let payer = Address::generate(env);
    let payee = Address::generate(env);
    let attester = signing_key(attester_seed);
    let releaser = account_address(env, &attester);
    asset.mint(&payer, &1_000);

    let contract_id = env.register(EscrowContract, (Vec::<Address>::new(env),));
    let client = EscrowContractClient::new(env, &contract_id);
    let escrow_id = client.create_escrow(
        &payer,
        &payee,
        &token_id,
        &300,
        &String::from_str(env, "attestation-condition-ref"),
        &releaser,
        &None,
        &false,
        &None,
    );

    Fixture {
        client,
        contract_id,
        token,
        payee,
        escrow_id,
        attester,
    }
}

#[test]
fn valid_attestation_releases_and_emits_one_event() {
    let env = Env::default();
    let f = funded_escrow(&env, 1);

    let message = message_bytes(&env, &f.client, f.escrow_id, ACTION_RELEASE);
    let signature = sign_message(&env, &f.attester, &message);

    let result = f.client.try_release_with_attestation(
        &f.escrow_id,
        &String::from_str(&env, ACTION_RELEASE),
        &signature,
    );

    assert!(result.is_ok());
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Released);
    assert_eq!(f.token.balance(&f.payee), 300);
}

#[test]
fn attestation_signed_by_a_different_key_is_rejected() {
    let env = Env::default();
    let f = funded_escrow(&env, 2);

    let message = message_bytes(&env, &f.client, f.escrow_id, ACTION_RELEASE);
    let impostor = signing_key(99);
    let signature = sign_message(&env, &impostor, &message);

    let result = f.client.try_release_with_attestation(
        &f.escrow_id,
        &String::from_str(&env, ACTION_RELEASE),
        &signature,
    );

    assert!(result.is_err());
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Funded);
    assert_eq!(f.token.balance(&f.payee), 0);
}

#[test]
fn signature_is_bound_to_the_escrow_id() {
    let env = Env::default();
    let f = funded_escrow(&env, 3);

    // Mint a valid signature for a different escrow id.
    let message = message_bytes(&env, &f.client, f.escrow_id + 1, ACTION_RELEASE);
    let signature = sign_message(&env, &f.attester, &message);

    let result = f.client.try_release_with_attestation(
        &f.escrow_id,
        &String::from_str(&env, ACTION_RELEASE),
        &signature,
    );

    assert!(result.is_err());
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Funded);
}

#[test]
fn signature_is_bound_to_the_network_id() {
    let env = Env::default();
    let f = funded_escrow(&env, 4);

    let message = message_bytes(&env, &f.client, f.escrow_id, ACTION_RELEASE);
    let signature = sign_message(&env, &f.attester, &message);

    // A testnet signature must not verify under another network id, even
    // for the same contract and escrow.
    env.ledger().set_network_id([9; 32]);

    let result = f.client.try_release_with_attestation(
        &f.escrow_id,
        &String::from_str(&env, ACTION_RELEASE),
        &signature,
    );

    assert!(result.is_err());
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Funded);
}

#[test]
fn signature_is_bound_to_the_action() {
    let env = Env::default();
    let f = funded_escrow(&env, 5);

    let message = message_bytes(&env, &f.client, f.escrow_id, "refund");
    let signature = sign_message(&env, &f.attester, &message);

    // An attestation minted for another action must not settle this escrow,
    // and the contract must reject the action outright instead of treating
    // it as a release.
    let result = f.client.try_release_with_attestation(
        &f.escrow_id,
        &String::from_str(&env, "refund"),
        &signature,
    );

    assert_eq!(
        result.unwrap_err(),
        Ok(EscrowError::InvalidAction)
    );
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Funded);
}

#[test]
fn attestation_message_layout_is_stable() {
    let env = Env::default();
    let f = funded_escrow(&env, 6);

    let message = message_bytes(&env, &f.client, f.escrow_id, ACTION_RELEASE);

    let mut offset = 0;
    let domain = &message[offset..offset + ATTESTATION_DOMAIN.len()];
    assert_eq!(domain, ATTESTATION_DOMAIN);
    offset += ATTESTATION_DOMAIN.len();

    assert_eq!(&message[offset..offset + 32], &NETWORK_ID);
    offset += 32;

    let contract_len = u32::from_be_bytes(message[offset..offset + 4].try_into().unwrap()) as usize;
    offset += 4;
    assert_eq!(contract_len, 56); // C… strkey length
    let contract = std::str::from_utf8(&message[offset..offset + contract_len]).unwrap();
    assert!(contract.starts_with('C'));
    offset += contract_len;

    assert_eq!(
        u64::from_be_bytes(message[offset..offset + 8].try_into().unwrap()),
        f.escrow_id
    );
    offset += 8;

    let action_len = u32::from_be_bytes(message[offset..offset + 4].try_into().unwrap()) as usize;
    offset += 4;
    assert_eq!(action_len, ACTION_RELEASE.len());
    assert_eq!(&message[offset..offset + action_len], ACTION_RELEASE.as_bytes());
    offset += action_len;

    assert_eq!(offset, message.len());
}

#[test]
fn quorum_escrow_cannot_be_released_with_an_attestation() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_network_id(NETWORK_ID);

    let admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(admin).address();
    let asset = StellarAssetClient::new(&env, &token_id);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let attester = signing_key(8);
    let releaser = account_address(&env, &attester);
    asset.mint(&payer, &1_000);

    let contract_id = env.register(EscrowContract, (Vec::<Address>::new(&env),));
    let client = EscrowContractClient::new(&env, &contract_id);
    let escrow_id = client.create_escrow_with_releasers(
        &payer,
        &payee,
        &token_id,
        &300,
        &String::from_str(&env, "quorum-attestation"),
        &Vec::from_array(&env, [releaser, Address::generate(&env)]),
        &2,
        &None,
        &false,
        &None,
    );

    let message = message_bytes(&env, &client, escrow_id, ACTION_RELEASE);
    let signature = sign_message(&env, &attester, &message);

    let result = client.try_release_with_attestation(
        &escrow_id,
        &String::from_str(&env, ACTION_RELEASE),
        &signature,
    );

    assert_eq!(result.unwrap_err(), Ok(EscrowError::ThresholdNotMet));
    assert_eq!(client.get_status(&escrow_id), EscrowStatus::Funded);
}

#[test]
fn contract_address_releaser_cannot_use_attestation() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_network_id(NETWORK_ID);

    let admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(admin).address();
    let asset = StellarAssetClient::new(&env, &token_id);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env); // C… — no ed25519 key
    asset.mint(&payer, &1_000);

    let contract_id = env.register(EscrowContract, (Vec::<Address>::new(&env),));
    let client = EscrowContractClient::new(&env, &contract_id);
    let escrow_id = client.create_escrow(
        &payer,
        &payee,
        &token_id,
        &300,
        &String::from_str(&env, "contract-releaser"),
        &releaser,
        &None,
        &false,
        &None,
    );

    let message = message_bytes(&env, &client, escrow_id, ACTION_RELEASE);
    let signature = sign_message(&env, &signing_key(9), &message);

    let result = client.try_release_with_attestation(
        &escrow_id,
        &String::from_str(&env, ACTION_RELEASE),
        &signature,
    );

    assert_eq!(result.unwrap_err(), Ok(EscrowError::InvalidSignature));
    assert_eq!(client.get_status(&escrow_id), EscrowStatus::Funded);
}

#[test]
fn attestation_cannot_release_twice() {
    let env = Env::default();
    let f = funded_escrow(&env, 10);

    let message = message_bytes(&env, &f.client, f.escrow_id, ACTION_RELEASE);
    let signature = sign_message(&env, &f.attester, &message);
    let action = String::from_str(&env, ACTION_RELEASE);

    f.client
        .release_with_attestation(&f.escrow_id, &action, &signature);
    let second = f
        .client
        .try_release_with_attestation(&f.escrow_id, &action, &signature);

    assert_eq!(second.unwrap_err(), Ok(EscrowError::NotFunded));
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Released);
}

#[test]
fn released_event_is_published_for_attestation_release() {
    let env = Env::default();
    let f = funded_escrow(&env, 11);

    let message = message_bytes(&env, &f.client, f.escrow_id, ACTION_RELEASE);
    let signature = sign_message(&env, &f.attester, &message);
    f.client
        .release_with_attestation(
            &f.escrow_id,
            &String::from_str(&env, ACTION_RELEASE),
            &signature,
        );

    // Testutils retains only the settlement invocation's events, so this
    // asserts the attestation path publishes exactly the one `released` event
    // the plain `release` path publishes.
    let mine = env.events().all().filter_by_contract(&f.contract_id);
    assert_eq!(mine.events().len(), 1);
}
