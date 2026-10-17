//! Tests for issue #47: opt-in uniqueness of (payer, condition_ref).
//!
//! Behaviour under test:
//!
//! - With `unique_ref = true`, a second `create_escrow` for the same
//!   `(payer, condition_ref)` fails with `DuplicateConditionRef` and
//!   `get_escrow_id_by_ref` returns the original id.
//! - With `unique_ref = false`, no uniqueness is enforced (caller opts out).
//! - The key does not collide across payers - two payers may use the same
//!   `condition_ref` independently.
//! - After settlement, the mapping is retained: a retry with `unique_ref = true`
//!   still returns `DuplicateConditionRef`, and `get_escrow_id_by_ref` still
//!   returns the (now settled) original id. This is the "keep forever"
//!   decision documented in the PR; callers who want to recycle a ref must
//!   pass `unique_ref = false` on the retry.
//! - `get_escrow_id_by_ref` on an unknown pair returns `NotFound`.

use docforum_escrow::{EscrowContract, EscrowContractClient, EscrowStatus};
use soroban_sdk::{
    testutils::Address as _,
    token::{StellarAssetClient, TokenClient},
    Address, Env, String,
};

fn setup() -> (Env, StellarAssetClient, TokenClient, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin);
    let token = TokenClient::new(&env, &sac.address());
    let asset = StellarAssetClient::new(&env, &sac.address());

    (env, asset, token, sac.address())
}

fn register_contract(env: &Env) -> (Address, EscrowContractClient<'_>) {
    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(env, &contract_id);
    (contract_id, client)
}

fn create(
    env: &Env,
    client: &EscrowContractClient,
    asset: &StellarAssetClient,
    token_addr: &Address,
    payer: &Address,
    payee: &Address,
    condition_ref: &str,
    unique_ref: bool,
) -> Result<u64, docforum_escrow::Error> {
    asset.mint(payer, &1000i128);
    client.try_create_escrow(
        payer,
        payee,
        token_addr,
        &100i128,
        &String::from_str(env, condition_ref),
        payer,
        &None,
        &unique_ref,
    )
}

// ---------------------------------------------------------------------------
// Duplicate + getter returns original id
// ---------------------------------------------------------------------------

#[test]
fn duplicate_ref_returns_error_and_getter_returns_existing_id() {
    let (env, asset, _token, token_addr) = setup();
    let (_contract_id, client) = register_contract(&env);

    let payer = Address::generate(&env);
    let payee = Address::generate(&env);

    let first = create(&env, &client, &asset, &token_addr, &payer, &payee, "invoice-1", true)
        .expect("first create should succeed");

    let second = create(&env, &client, &asset, &token_addr, &payer, &payee, "invoice-1", true);
    assert_eq!(
        second,
        Err(Ok(docforum_escrow::Error::DuplicateConditionRef))
    );

    let recovered = client.get_escrow_id_by_ref(&payer, &String::from_str(&env, "invoice-1"));
    assert_eq!(recovered, first);

    assert_eq!(client.get_status(&first), EscrowStatus::Funded);
}

// ---------------------------------------------------------------------------
// Different payer, same ref - allowed
// ---------------------------------------------------------------------------

#[test]
fn different_payer_same_ref_is_allowed() {
    let (env, asset, _token, token_addr) = setup();
    let (_contract_id, client) = register_contract(&env);

    let payer_a = Address::generate(&env);
    let payer_b = Address::generate(&env);
    let payee = Address::generate(&env);

    let id_a = create(&env, &client, &asset, &token_addr, &payer_a, &payee, "shared-ref", true)
        .expect("payer A should succeed");
    let id_b = create(&env, &client, &asset, &token_addr, &payer_b, &payee, "shared-ref", true)
        .expect("payer B should succeed independently");

    assert_ne!(id_a, id_b);

    assert_eq!(
        client.get_escrow_id_by_ref(&payer_a, &String::from_str(&env, "shared-ref")),
        id_a
    );
    assert_eq!(
        client.get_escrow_id_by_ref(&payer_b, &String::from_str(&env, "shared-ref")),
        id_b
    );
}

// ---------------------------------------------------------------------------
// Opt-out: unique_ref = false skips uniqueness
// ---------------------------------------------------------------------------

#[test]
fn unique_ref_false_skips_uniqueness() {
    let (env, asset, _token, token_addr) = setup();
    let (_contract_id, client) = register_contract(&env);

    let payer = Address::generate(&env);
    let payee = Address::generate(&env);

    let first = create(&env, &client, &asset, &token_addr, &payer, &payee, "casual-ref", false)
        .expect("first create should succeed");
    let second = create(&env, &client, &asset, &token_addr, &payer, &payee, "casual-ref", false)
        .expect("second create should also succeed (unique_ref off)");

    assert_ne!(first, second);

    // No key was written, so the getter returns NotFound.
    assert_eq!(
        client.try_get_escrow_id_by_ref(&payer, &String::from_str(&env, "casual-ref")),
        Err(Ok(docforum_escrow::Error::NotFound))
    );
}

// ---------------------------------------------------------------------------
// Settled escrow still blocks the same ref (keep-forever decision)
// ---------------------------------------------------------------------------

#[test]
fn settled_escrow_still_blocks_same_ref() {
    let (env, asset, _token, token_addr) = setup();
    let (_contract_id, client) = register_contract(&env);

    let payer = Address::generate(&env);
    let payee = Address::generate(&env);

    let first = create(&env, &client, &asset, &token_addr, &payer, &payee, "settled-ref", true)
        .expect("first create should succeed");

    client.release(&first, &payer);
    assert_eq!(client.get_status(&first), EscrowStatus::Released);

    // Retry after settlement still sees the duplicate.
    let retry = create(&env, &client, &asset, &token_addr, &payer, &payee, "settled-ref", true);
    assert_eq!(
        retry,
        Err(Ok(docforum_escrow::Error::DuplicateConditionRef))
    );

    // And the original (settled) id is recoverable.
    let recovered = client.get_escrow_id_by_ref(&payer, &String::from_str(&env, "settled-ref"));
    assert_eq!(recovered, first);

    // Retry with unique_ref = false bypasses the guard, per docs.
    let opt_out = create(&env, &client, &asset, &token_addr, &payer, &payee, "settled-ref", false)
        .expect("unique_ref=false should create a new escrow with the reused ref");
    assert_ne!(opt_out, first);
}

// ---------------------------------------------------------------------------
// Getter on unknown pair - NotFound
// ---------------------------------------------------------------------------

#[test]
fn get_escrow_id_by_ref_errors_for_unknown() {
    let (env, _asset, _token, _token_addr) = setup();
    let (_contract_id, client) = register_contract(&env);

    let payer = Address::generate(&env);
    let result = client.try_get_escrow_id_by_ref(&payer, &String::from_str(&env, "never-used"));
    assert_eq!(result, Err(Ok(docforum_escrow::Error::NotFound)));
}

// ---------------------------------------------------------------------------
// Storage cost of the ref key (informational)
// ---------------------------------------------------------------------------

#[test]
fn storage_cost_of_ref_key_estimate() {
    let (env, asset, _token, token_addr) = setup();
    let (_contract_id, client) = register_contract(&env);

    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let condition_ref = "inv-2026-0001";
    let _ = create(&env, &client, &asset, &token_addr, &payer, &payee, condition_ref, true)
        .expect("create should succeed");

    // Rough estimate for the ConditionRef entry:
    // 32 (address) + 4 (string length header) + condition_ref.len()
    // + 8 (u64 value). Printed for the PR body.
    let estimate = 32u64 + 4 + condition_ref.len() as u64 + 8;
    std::println!(
        "storage cost of ConditionRef((payer, {condition_ref})) ~= {estimate} bytes (rough estimate)"
    );
    assert!(estimate > 0);
}