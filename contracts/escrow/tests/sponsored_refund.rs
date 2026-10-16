// Phase E5 tests — sponsored funding: an optional `refund_to` distinct from
// the funder (`payer`) (issue #28, docs/adr/0005). Per AGENTS.md hard
// rule 2: payment logic changes need tests here before merge.
//
// Covered:
//   - every refund path with a distinct `refund_to`: releaser refund and
//     timeout refund (stranger, funder, exactly at the deadline)
//   - invariant I1: `refund_to` is fixed at creation; nobody chooses a
//     destination at payout, and release still goes to the payee
//   - default (`None`) behaves exactly like before: refunds go to `payer`
//   - `refund_to` may not be the contract itself
//   - funder auth is required at creation; the beneficiary signs nothing
//   - `get_escrow` exposes `refund_to` for payees (threat model T8)

use docforum_escrow::{Error, EscrowContract, EscrowContractClient, EscrowStatus};
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    Address, Env, String,
};

const CREATED_AT: u64 = 1_000;
const DEADLINE: u64 = 1_100;

struct Fixture<'a> {
    client: EscrowContractClient<'a>,
    token: TokenClient<'a>,
    contract_id: Address,
    payer: Address,
    payee: Address,
    releaser: Address,
    refund_to: Address,
    escrow_id: u64,
}

/// Funds a 300-unit escrow. With `distinct_refund_to` a fresh address is
/// passed as `refund_to`; otherwise it is omitted (default = payer).
fn fund<'a>(env: &'a Env, distinct_refund_to: bool, refund_after: Option<u64>) -> Fixture<'a> {
    env.ledger().set_timestamp(CREATED_AT);

    let admin = Address::generate(env);
    let sac = env.register_stellar_asset_contract_v2(admin);
    let token = TokenClient::new(env, &sac.address());
    let asset = StellarAssetClient::new(env, &sac.address());
    let payer = Address::generate(env);
    let payee = Address::generate(env);
    let releaser = Address::generate(env);
    asset.mint(&payer, &1_000);

    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(env, &contract_id);

    let (refund_to, arg) = if distinct_refund_to {
        let r = Address::generate(env);
        (r.clone(), Some(r))
    } else {
        (payer.clone(), None)
    };
    let escrow_id = client.create_escrow(
        &payer,
        &payee,
        &sac.address(),
        &300,
        &String::from_str(env, "opaque-condition-ref"),
        &releaser,
        &refund_after,
        &arg,
    );

    Fixture { client, token, contract_id, payer, payee, releaser, refund_to, escrow_id }
}

// --- each refund path with a distinct refund_to ---------------------------

#[test]
fn releaser_refund_goes_to_refund_to_not_the_funder() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund(&env, true, None);
    assert_ne!(f.refund_to, f.payer);

    f.client.refund(&f.escrow_id, &f.releaser);

    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Refunded);
    assert_eq!(f.token.balance(&f.refund_to), 300);
    assert_eq!(f.token.balance(&f.payer), 700); // the funder is NOT repaid
    assert_eq!(f.token.balance(&f.payee), 0);
    assert_eq!(f.token.balance(&f.contract_id), 0);
}

#[test]
fn timeout_refund_by_a_stranger_goes_to_refund_to() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund(&env, true, Some(DEADLINE));
    let stranger = Address::generate(&env);

    env.ledger().set_timestamp(DEADLINE + 1);
    f.client.refund(&f.escrow_id, &stranger);

    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Refunded);
    assert_eq!(f.token.balance(&f.refund_to), 300);
    assert_eq!(f.token.balance(&f.payer), 700);
    assert_eq!(f.token.balance(&stranger), 0);
    assert_eq!(f.token.balance(&f.contract_id), 0);
}

#[test]
fn timeout_refund_at_the_exact_deadline_goes_to_refund_to() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund(&env, true, Some(DEADLINE));

    env.ledger().set_timestamp(DEADLINE);
    f.client.refund(&f.escrow_id, &Address::generate(&env));

    assert_eq!(f.token.balance(&f.refund_to), 300);
    assert_eq!(f.token.balance(&f.payer), 700);
}

#[test]
fn funder_calling_refund_after_the_deadline_cannot_steer_the_money_to_itself() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund(&env, true, Some(DEADLINE));

    // After the deadline the funder is just "anyone".
    env.ledger().set_timestamp(DEADLINE + 1);
    f.client.refund(&f.escrow_id, &f.payer);

    assert_eq!(f.token.balance(&f.refund_to), 300);
    assert_eq!(f.token.balance(&f.payer), 700);
}

#[test]
fn neither_funder_nor_refund_to_may_trigger_a_refund_before_the_deadline() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund(&env, true, Some(DEADLINE));

    // Being the funder or the refund destination grants no authority.
    assert_eq!(
        f.client.try_refund(&f.escrow_id, &f.refund_to),
        Err(Ok(Error::Unauthorized))
    );
    assert_eq!(
        f.client.try_refund(&f.escrow_id, &f.payer),
        Err(Ok(Error::Unauthorized))
    );
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Funded);
    assert_eq!(f.token.balance(&f.contract_id), 300);
}

// --- I1: destinations fixed at creation -----------------------------------

#[test]
fn refund_to_is_fixed_at_creation_and_visible_via_get_escrow() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund(&env, true, None);

    let data = f.client.get_escrow(&f.escrow_id);
    assert_eq!(data.refund_to, f.refund_to);
    assert_eq!(data.payer, f.payer);
    assert_ne!(data.refund_to, data.payer);

    // Nothing on the contract surface changes it: after a rejected refund
    // attempt and a lot of time passing, it is the same value.
    let _ = f.client.try_refund(&f.escrow_id, &Address::generate(&env));
    env.ledger().set_timestamp(CREATED_AT + 999_999);
    assert_eq!(f.client.get_escrow(&f.escrow_id).refund_to, f.refund_to);
}

#[test]
fn release_still_pays_the_payee_not_refund_to() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund(&env, true, None);

    f.client.release(&f.escrow_id, &f.releaser);

    assert_eq!(f.token.balance(&f.payee), 300);
    assert_eq!(f.token.balance(&f.refund_to), 0);
    assert_eq!(f.token.balance(&f.payer), 700);
}

#[test]
fn settled_escrow_cannot_be_refunded_to_refund_to_afterwards() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund(&env, true, Some(DEADLINE));

    f.client.release(&f.escrow_id, &f.releaser);
    env.ledger().set_timestamp(DEADLINE + 1);
    let result = f.client.try_refund(&f.escrow_id, &Address::generate(&env));

    assert_eq!(result, Err(Ok(Error::NotFunded)));
    assert_eq!(f.token.balance(&f.refund_to), 0);
    assert_eq!(f.token.balance(&f.payee), 300);
}

#[test]
fn double_refund_pays_refund_to_once() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund(&env, true, None);

    f.client.refund(&f.escrow_id, &f.releaser);
    let result = f.client.try_refund(&f.escrow_id, &f.releaser);

    assert_eq!(result, Err(Ok(Error::NotFunded)));
    assert_eq!(f.token.balance(&f.refund_to), 300);
}

#[test]
fn two_escrows_keep_their_own_refund_to() {
    let env = Env::default();
    env.mock_all_auths();
    let a = fund(&env, true, None);

    // Second escrow in the same contract and token, different refund_to.
    let other = Address::generate(&env);
    let second = a.client.create_escrow(
        &a.payer,
        &a.payee,
        &a.token.address,
        &200,
        &String::from_str(&env, "second"),
        &a.releaser,
        &None,
        &Some(other.clone()),
    );

    a.client.refund(&second, &a.releaser);
    assert_eq!(a.token.balance(&other), 200);
    assert_eq!(a.token.balance(&a.refund_to), 0);

    a.client.refund(&a.escrow_id, &a.releaser);
    assert_eq!(a.token.balance(&a.refund_to), 300);
    assert_eq!(a.token.balance(&other), 200);
}

// --- default behaviour unchanged when omitted ------------------------------

#[test]
fn omitted_refund_to_defaults_to_payer() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund(&env, false, None);

    assert_eq!(f.client.get_escrow(&f.escrow_id).refund_to, f.payer);
    f.client.refund(&f.escrow_id, &f.releaser);

    assert_eq!(f.token.balance(&f.payer), 1_000);
    assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Refunded);
}

#[test]
fn omitted_refund_to_timeout_refund_still_goes_to_payer() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund(&env, false, Some(DEADLINE));

    env.ledger().set_timestamp(DEADLINE + 1);
    f.client.refund(&f.escrow_id, &Address::generate(&env));

    assert_eq!(f.token.balance(&f.payer), 1_000);
}

#[test]
fn explicit_refund_to_equal_to_payer_behaves_like_the_default() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin);
    let token = TokenClient::new(&env, &sac.address());
    let payer = Address::generate(&env);
    StellarAssetClient::new(&env, &sac.address()).mint(&payer, &1_000);
    let releaser = Address::generate(&env);
    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);

    let id = client.create_escrow(
        &payer,
        &Address::generate(&env),
        &sac.address(),
        &300,
        &String::from_str(&env, "ref"),
        &releaser,
        &None,
        &Some(payer.clone()),
    );
    client.refund(&id, &releaser);

    assert_eq!(token.balance(&payer), 1_000);
}

// --- refund_to can't be the contract itself --------------------------------

#[test]
fn create_escrow_rejects_the_contract_as_refund_to() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin);
    let token = TokenClient::new(&env, &sac.address());
    let payer = Address::generate(&env);
    StellarAssetClient::new(&env, &sac.address()).mint(&payer, &1_000);
    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);

    let result = client.try_create_escrow(
        &payer,
        &Address::generate(&env),
        &sac.address(),
        &300,
        &String::from_str(&env, "ref"),
        &Address::generate(&env),
        &None,
        &Some(contract_id.clone()),
    );

    assert_eq!(result, Err(Ok(Error::InvalidRefundTo)));
    // Rejected before any funds moved, and no escrow was created.
    assert_eq!(token.balance(&payer), 1_000);
    assert_eq!(token.balance(&contract_id), 0);
    assert_eq!(client.try_get_status(&0), Err(Ok(Error::NotFound)));
}

// --- who must authorise ------------------------------------------------------

#[test]
fn create_escrow_with_refund_to_requires_the_funders_auth() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin);
    let token = TokenClient::new(&env, &sac.address());
    let payer = Address::generate(&env);
    env.mock_all_auths();
    StellarAssetClient::new(&env, &sac.address()).mint(&payer, &1_000);
    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);

    // Drop every mocked auth: nobody signed, so creation must fail even
    // though `refund_to` is a perfectly valid address.
    env.mock_auths(&[]);
    let result = client.try_create_escrow(
        &payer,
        &Address::generate(&env),
        &sac.address(),
        &300,
        &String::from_str(&env, "ref"),
        &Address::generate(&env),
        &None,
        &Some(Address::generate(&env)),
    );

    assert!(result.is_err());
    assert_eq!(token.balance(&payer), 1_000);
}

#[test]
fn the_beneficiary_refund_to_never_has_to_sign() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund(&env, true, None);

    // `auths()` reflects the authorisations used by the last invocation
    // (create_escrow): the funder's, and never the refund destination's.
    let signers: std::vec::Vec<Address> =
        env.auths().into_iter().map(|(addr, _)| addr).collect();
    assert!(signers.contains(&f.payer));
    assert!(!signers.contains(&f.refund_to));
}
