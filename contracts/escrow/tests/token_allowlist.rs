// Phase E5 tests — the immutable deploy-time token allowlist and its
// read-only getter (issue #299). Per AGENTS.md hard rule 2: contract
// logic changes need tests here in the same PR.
//
// Coverage:
//   - a configured allowlist accepts a listed token
//   - a configured allowlist rejects an unlisted token *before* any funds
//     move, with TokenNotAllowed
//   - an empty allowlist preserves the legacy allow-any-token behaviour
//   - get_allowed_tokens() returns exactly what was configured, and an
//     empty list when the constructor was given one (the "missing key"
//     fallback path returns an empty list rather than trapping)
//
// The allowlist key is written by the constructor and has no setter, so
// these tests are also the guarantee that the list cannot drift: the
// getter and the enforcement read the same instance-storage key.

use docforum_escrow::{Error, EscrowContract, EscrowContractClient};
use soroban_sdk::{
    testutils::Address as _,
    token::{StellarAssetClient, TokenClient},
    Address, Env, String, Vec,
};

fn create_token<'a>(env: &'a Env) -> (Address, TokenClient<'a>, StellarAssetClient<'a>) {
    let admin = Address::generate(env);
    let contract_id = env.register_stellar_asset_contract_v2(admin);
    (
        contract_id.address(),
        TokenClient::new(env, &contract_id.address()),
        StellarAssetClient::new(env, &contract_id.address()),
    )
}

fn deploy<'a>(env: &'a Env, allowed_tokens: Vec<Address>) -> (Address, EscrowContractClient<'a>) {
    let contract_id = env.register(EscrowContract, (allowed_tokens,));
    (contract_id.clone(), EscrowContractClient::new(env, &contract_id))
}

fn create_escrow<'a>(
    env: &'a Env,
    client: &EscrowContractClient<'a>,
    token: &Address,
    payer: &Address,
) -> Result<u64, Error> {
    // Flatten the two error layers `try_*` exposes: the contract's own
    // `Error` (what these tests assert on) and a host-level trap, which
    // would be a test failure rather than an expected rejection.
    match client.try_create_escrow(
        payer,
        &Address::generate(env),
        token,
        &100,
        &String::from_str(env, "allowlist-test"),
        &Address::generate(env),
        &None,
    ) {
        Ok(Ok(escrow_id)) => Ok(escrow_id),
        Err(Ok(error)) => Err(error),
        _ => panic!("create_escrow trapped instead of returning a contract error"),
    }
}

#[test]
fn configured_allowlist_accepts_listed_token_and_rejects_unlisted_token() {
    let env = Env::default();
    env.mock_all_auths();

    let (allowed_token, _, allowed_asset) = create_token(&env);
    let (unlisted_token, _, unlisted_asset) = create_token(&env);
    let payer = Address::generate(&env);
    allowed_asset.mint(&payer, &500);
    unlisted_asset.mint(&payer, &500);

    let mut allowlist = Vec::new(&env);
    allowlist.push_back(allowed_token.clone());
    let (contract_id, client) = deploy(&env, allowlist.clone());

    assert_eq!(client.get_allowed_tokens(), allowlist);

    // Listed token: creation succeeds and funds move.
    let escrow_id = create_escrow(&env, &client, &allowed_token, &payer).unwrap();
    assert_eq!(escrow_id, 0);
    assert_eq!(allowed_asset.balance(&payer), 400);

    // Unlisted token: rejected with TokenNotAllowed, and no funds move.
    let rejected = create_escrow(&env, &client, &unlisted_token, &payer);
    assert_eq!(rejected, Err(Error::TokenNotAllowed));
    assert_eq!(unlisted_asset.balance(&payer), 500);
    assert_eq!(unlisted_asset.balance(&contract_id), 0);
    assert_eq!(client.get_allowed_tokens(), allowlist);
}

#[test]
fn empty_allowlist_preserves_open_token_behavior() {
    let env = Env::default();
    env.mock_all_auths();

    let (token, _, asset) = create_token(&env);
    let payer = Address::generate(&env);
    asset.mint(&payer, &500);

    let (_contract_id, client) = deploy(&env, Vec::new(&env));

    // The getter is total for a list that was not configured: empty, not
    // a trap. Empty means any token is accepted.
    assert!(client.get_allowed_tokens().is_empty());
    assert_eq!(create_escrow(&env, &client, &token, &payer).unwrap(), 0);
    assert_eq!(asset.balance(&payer), 400);
}

#[test]
fn get_allowed_tokens_returns_every_configured_token_in_order() {
    let env = Env::default();
    env.mock_all_auths();

    let (first, _, _) = create_token(&env);
    let (second, _, _) = create_token(&env);
    let mut allowlist = Vec::new(&env);
    allowlist.push_back(first.clone());
    allowlist.push_back(second.clone());

    let (_contract_id, client) = deploy(&env, allowlist.clone());

    // Read-only: repeated calls return the same list, and the getter does
    // not depend on any caller or auth.
    assert_eq!(client.get_allowed_tokens(), allowlist);
    assert_eq!(client.get_allowed_tokens(), allowlist);
}

#[test]
fn allowlist_rejection_precedes_the_funding_transfer() {
    let env = Env::default();
    env.mock_all_auths();

    let (allowed, _, _) = create_token(&env);
    let (unlisted, _, unlisted_asset) = create_token(&env);
    let payer = Address::generate(&env);
    unlisted_asset.mint(&payer, &1_000);

    let mut allowlist = Vec::new(&env);
    allowlist.push_back(allowed);
    let (_contract_id, client) = deploy(&env, allowlist);

    let rejected = create_escrow(&env, &client, &unlisted, &payer);
    assert_eq!(rejected, Err(Error::TokenNotAllowed));
    // The payer's balance is untouched: the allowlist check runs before
    // `token.transfer`, so a rejected attempt cannot cost funds.
    assert_eq!(unlisted_asset.balance(&payer), 1_000);
}
