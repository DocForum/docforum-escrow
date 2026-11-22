// Phase E5 tests — attestation-based release (issue #42). Per AGENTS.md
// hard rule 2: contract changes need tests here before merge.
//
// The attester signs a domain-separated message (contract id, network id,
// escrow id, action) offline; anyone may submit it. A bad signature traps
// the invocation (`ed25519_verify` panics), a settled escrow rejects a
// second use with `NotFunded`, and the message binds the contract and the
// network, so cross-contract and cross-network replays fail.

use docforum_escrow::{Error, EscrowContract, EscrowContractClient, EscrowStatus};
use ed25519_dalek::{Signer, SigningKey};
use soroban_sdk::{
    testutils::{Address as _, Ledger as _, MockAuth, MockAuthInvoke},
    token::{StellarAssetClient, TokenClient},
    Address, BytesN, Env, IntoVal, String, Vec,
};

const DOMAIN: &[u8] = b"docforum-escrow:release-attestation:v1";
const ACTION: &[u8] = b"release";

fn setup<'a>(env: &Env) -> (Address, TokenClient<'a>, StellarAssetClient<'a>) {
    let admin = Address::generate(env);
    let contract_id = env.register_stellar_asset_contract_v2(admin);
    let token = TokenClient::new(env, &contract_id.address());
    let asset = StellarAssetClient::new(env, &contract_id.address());
    (contract_id.address(), token, asset)
}

struct Fixture<'a> {
    contract_id: Address,
    client: EscrowContractClient<'a>,
    token: TokenClient<'a>,
    token_id: Address,
    payer: Address,
    payee: Address,
    releaser: Address,
    escrow_id: u64,
    signing_key: SigningKey,
    attester: BytesN<32>,
}

fn fund_attested_escrow(env: &Env, amount: i128) -> Fixture<'_> {
    let (token_id, token, asset) = setup(env);
    let payer = Address::generate(env);
    let payee = Address::generate(env);
    let releaser = Address::generate(env);
    asset.mint(&payer, &1_000);

    let contract_id = env.register(
        EscrowContract,
        (Vec::<Address>::new(env), Address::generate(env)),
    );
    let client = EscrowContractClient::new(env, &contract_id);

    // Fixed seed, so the keypair is the same on every run.
    let signing_key = SigningKey::from_bytes(&[7u8; 32]);
    let attester = BytesN::from_array(env, signing_key.verifying_key().as_bytes());

    let escrow_id = client.create_escrow_with_attester(
        &payer,
        &payee,
        &token_id,
        &amount,
        &String::from_str(env, "opaque-condition-ref"),
        &releaser,
        &None,
        &false,
        &None,
        &Some(attester.clone()),
    );

    Fixture {
        contract_id,
        client,
        token,
        token_id,
        payer,
        payee,
        releaser,
        escrow_id,
        signing_key,
        attester,
    }
}

/// Builds the attested message independently of the contract, from the
/// layout in `contracts/escrow/src/attestation.rs`.
fn expected_message(env: &Env, contract_id: &Address, escrow_id: u64) -> std::vec::Vec<u8> {
    let mut message = DOMAIN.to_vec();
    let strkey = contract_id.to_string();
    let mut contract_id_bytes = [0u8; 56];
    strkey.copy_into_slice(&mut contract_id_bytes);
    message.extend_from_slice(&contract_id_bytes);
    message.extend_from_slice(&env.ledger().network_id().to_array());
    message.extend_from_slice(&escrow_id.to_be_bytes());
    message.extend_from_slice(ACTION);
    message
}

fn sign(env: &Env, f: &Fixture<'_>, contract_id: &Address, escrow_id: u64) -> BytesN<64> {
    let message = expected_message(env, contract_id, escrow_id);
    let signature = f.signing_key.sign(&message);
    BytesN::from_array(env, &signature.to_bytes())
}

fn authorize_settlement(env: &Env, f: &Fixture<'_>, fn_name: &str, caller: &Address) {
    let invoke = MockAuthInvoke {
        contract: &f.contract_id,
        fn_name,
        args: (f.escrow_id, caller.clone()).into_val(env),
        sub_invokes: &[],
    };
    env.mock_auths(&[MockAuth {
        address: caller,
        invoke: &invoke,
    }]);
}

#[test]
fn release_with_attestation_pays_payee_and_marks_released() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund_attested_escrow(&env, 300);
    let signature = sign(&env, &f, &f.contract_id, f.escrow_id);

    // The submitter needs no authorization at all: anyone may submit.
    f.client
        .release_with_attestation(&f.escrow_id, &signature);
    assert!(env.auths().is_empty());

    assert_eq!(f.token.balance(&f.payee), 300);
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Released);
}

#[test]
fn release_with_attestation_rejects_bad_signature() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund_attested_escrow(&env, 300);
    // Signed for a different escrow id than the one being released.
    let signature = sign(&env, &f, &f.contract_id, 999);

    let result = f
        .client
        .try_release_with_attestation(&f.escrow_id, &signature);

    assert!(result.is_err());
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Funded);
    assert_eq!(f.token.balance(&f.payee), 0);
}

#[test]
fn release_with_attestation_rejects_wrong_network() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund_attested_escrow(&env, 300);
    let signature = sign(&env, &f, &f.contract_id, f.escrow_id);

    // The attestation was signed for the ledger's network; move the
    // contract to another network and the same signature must fail.
    env.ledger().set_network_id([9u8; 32]);
    let result = f
        .client
        .try_release_with_attestation(&f.escrow_id, &signature);

    assert!(result.is_err());
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Funded);
}

#[test]
fn release_with_attestation_rejects_cross_contract_replay() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund_attested_escrow(&env, 300);

    // A second contract instance: same attester, and its first escrow is
    // id 0 too. The attestation signed for the first contract must not
    // release here, because the message binds the contract id.
    let other_id = env.register(
        EscrowContract,
        (Vec::<Address>::new(&env), Address::generate(&env)),
    );
    let other = EscrowContractClient::new(&env, &other_id);
    let other_escrow = other.create_escrow_with_attester(
        &f.payer,
        &f.payee,
        &f.token_id,
        &300,
        &String::from_str(&env, "opaque-condition-ref"),
        &f.releaser,
        &None,
        &false,
        &None,
        &Some(f.attester.clone()),
    );
    assert_eq!(other_escrow, f.escrow_id);

    let signature = sign(&env, &f, &f.contract_id, f.escrow_id);
    let result = other.try_release_with_attestation(&other_escrow, &signature);

    assert!(result.is_err());
    assert_eq!(other.get_status(&other_escrow), EscrowStatus::Funded);
}

#[test]
fn release_with_attestation_cannot_be_replayed() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund_attested_escrow(&env, 300);
    let signature = sign(&env, &f, &f.contract_id, f.escrow_id);

    f.client
        .release_with_attestation(&f.escrow_id, &signature);
    let second = f
        .client
        .try_release_with_attestation(&f.escrow_id, &signature);

    assert!(second.is_err());
    assert_eq!(f.token.balance(&f.payee), 300); // unchanged by the replay
}

#[test]
fn release_with_attestation_needs_an_attester() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund_attested_escrow(&env, 300);
    let signature = sign(&env, &f, &f.contract_id, f.escrow_id);

    // A plain escrow with no attester: the same signature has no public
    // key to check against. Create one and try it there.
    let plain_id = f.client.create_escrow(
        &f.payer,
        &f.payee,
        &f.token_id,
        &100,
        &String::from_str(&env, "opaque-condition-ref"),
        &f.releaser,
        &None,
        &false,
        &None,
        &None,
        &None,
    );
    let result = f
        .client
        .try_release_with_attestation(&plain_id, &signature);

    assert_eq!(result, Err(Ok(Error::AttesterNotConfigured)));
    assert_eq!(f.client.get_status(&plain_id), EscrowStatus::Funded);
}

#[test]
fn attester_is_stored_and_plain_escrows_have_none() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund_attested_escrow(&env, 300);

    let data = f.client.get_escrow(&f.escrow_id);
    assert_eq!(data.attester, Some(f.attester.clone()));

    let plain_id = f.client.create_escrow(
        &f.payer,
        &f.payee,
        &f.token_id,
        &100,
        &String::from_str(&env, "opaque-condition-ref"),
        &f.releaser,
        &None,
        &false,
        &None,
        &None,
        &None,
    );
    let plain = f.client.get_escrow(&plain_id);
    assert_eq!(plain.attester, None);
}

#[test]
fn releaser_can_still_release_an_attested_escrow() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund_attested_escrow(&env, 300);

    authorize_settlement(&env, &f, "release", &f.releaser);
    f.client.release(&f.escrow_id, &f.releaser);

    assert_eq!(f.token.balance(&f.payee), 300);
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Released);
}
