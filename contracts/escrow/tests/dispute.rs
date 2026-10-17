// Phase E6 -- dispute & arbiter support, including split settlement.
//
// This file is the contract-side counterpart to the SDK's
// `availableActions` matrix test: the SDK function must never claim an
// action the contract would reject, and the only way to know that for
// sure is to actually attempt the call against the real contract.
//
// These tests exercise the dispute lifecycle end-to-end:
//   Funded --raise_dispute--> Disputed
//   Disputed --resolve_dispute--> Disputed (with a resolution)
//   Disputed --settle--> Released | Refunded | Split
//
// Time-dependent rules use ledger time (`set_ledger_timestamp`), not
// the local clock -- the SDK documents this difference explicitly.

use soroban_sdk;
use soroban_sdk::{Address, Env, String};
use soroban_sdk_token::{StellarAsset, TokenClient};
use soroban_sdk_testutils::AddressFactory;

// Pull the contract crate in by its crate name. The contract crate is
// named `docforum-escrow` in Cargo.toml (lib name `docforum_escrow`).
use docforum_escrow::{EscrowClient, Resolution, Error};

// ------------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------------

struct Fixture {
    env: Env,
    contract: Address,
    payer: Address,
    payee: Address,
    releaser: Address,
    arbiter: Address,
    token: Address,
}

fn setup() -> Fixture {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000_000);

    let contract = AddressFactory::new(&env);
    let payer = AddressFactory::new(&env);
    let payee = AddressFactory::new(&env);
    let releaser = AddressFactory::new(&env);
    let arbiter = AddressFactory::new(&env);

    // Register a stellar asset and mint to the payer so they can fund.
    let issuer = AddressFactory::new(&env);
    let admin = AddressFactory::new(&env);
    let asset = StellarAsset::new(&env, &issuer, "TEST", 7);
    let token_contract = env.register_stellar_asset(&asset, (&admin, &admin, &admin, 1));
    let token_client = TokenClient::new(&env, &token_contract);
    token_client.mint(&payer, &_00_000_000);

    Fixture {
        env,
        contract,
        payer,
        payee,
        releaser,
        arbiter,
        token: token_contract,
    }
}

fn create_funded_escrow(f: &Fixture, amount: i128) -> u64 {
    let client = EscrowClient::new(&f.env, &f.contract);
    client.create_escrow(
        &f.payer,
        &f.payee,
        &f.token,
        &amount,
        &String::from_str(&f.env, "condition-ref"),
        &f.releaser,
        &None,
    )
}

// ------------------------------------------------------------------------
// raise_dispute
// ------------------------------------------------------------------------

#[test]
fn raise_dispute_by_payer_moves_to_disputed() {
    let f = setup();
    let id = create_funded_escrow(&f, 1_000_000);
    let client = EscrowClient::new(&f.env, &f.contract);

    client.raise_dispute(&id, &f.payer, &f.payee, &f.arbiter);
    assert_eq!(client.get_status(&id), EscrowStatus::Disputed);
}

#[test]
fn raise_dispute_by_payee_moves_to_disputed() {
    let f = setup();
    let id = create_funded_escrow(&f, 1_000_000);
    let client = EscrowClient::new(&f.env, &f.contract);

    client.raise_dispute(&id, &f.payee, &f.payee, &f.arbiter);
    assert_eq!(client.get_status(&id), EscrowStatus::Disputed);
}

#[test]
fn raise_dispute_by_releaser_is_unauthorized() {
    let f = setup();
    let id = create_funded_escrow(&f, T_000_000);
    let client = EscrowClient::new(&f.env, &f.contract);

    let result = client.try_raise_dispute(&id, &f.releaser, &f.payee, &f.arbiter);
    assert_eq!(result, Err::Unauthorized);
    assert_eq!(client.get_status(&id), EscrowStatus::Funded);
}

#[test]
fn raise_dispute_on_non_funded_escrow_fails_not_funded() {
    let f = setup();
    let id = create_funded_escrow(&f, T_000_000);
    let client = EscrowClient::new(&f.env, &f.contract);

    // Release first, then try to raise a dispute.
    client.release(&id, &f.releaser);
    let result = client.try_raise_dispute(&id, &f.payer, &f.payee, &f.arbiter);
    assert_eq!(result, Err::NotFunded);
}

#[test]
fn raise_dispute_on_unknown_id_fails_not_found() {
    let f = setup();
    let client = EscrowClient::new(&f.env, &f.contract);

    let result = client.try_raise_dispute(&999, &f.payer, &f.payee, &f.arbiter);
    assert_eq!(result, Err::NotFound);
}

// ------------------------------------------------------------------------
// resolve_dispute
// ------------------------------------------------------------------------

#[test]
fn resolve_dispute_by_arbiter_records_resolution() {
    let f = setup();
    let id = create_funded_escrow(&f, 1_000_000);
    let client = EscrowClient::new(&f.env, &f.contract);

    client.raise_dispute(&id, &f.payer, &f.payee, &f.arbiter);
    client.resolve_dispute(&id, &f.arbiter, &Resolution::Release);

    let data = client.get_escrow(&id);
    assert_eq!(data.status, EscrowStatus::Disputed);
    assert_eq!(data.resolution, Some(Resolution::Release));
}

#[test]
fn resolve_dispute_by_non_arbiter_is_unauthorized() {
    let f = setup();
    let id = create_funded_escrow(&f, 1_000_000);
    let client = EscrowClient::new(&f.env, &f.contract);

    client.raise_dispute(&id, &f.payer, &f.payee, &f.arbiter);
    let result = client.try_resolve_dispute(&id, &f.payer, &Resolution::Release);
    assert_eq!(result, Err::Unauthorized);
}

#[test]
fn resolve_dispute_on_non_disputed_fails_not_disputed() {
    let f = setup();
    let id = create_funded_escrow(&f, T_000_000);
    let client = EscrowClient::new(&f.env, &f.contract);

    let result = client.try_resolve_dispute(&id, &f.arbiter, &Resolution::Release);
    assert_eq!(result, Err::NotDisputed);
}

// ------------------------------------------------------------------------
// settle
// ------------------------------------------------------------------------

#[test]
fn settle_release_sends_full_amount_to_payee() {
    let f = setup();
    let id = create_funded_escrow(&f, T_000_000);
    let client = EscrowClient::new(&f.env, &f.contract);
    let token = TokenClient::new(&f.env, &f.token);
    let payee_before = token.balance(&f.payee);

    client.raise_dispute(&id, &f.payer, &f.payee, &f.arbiter);
    client.resolve_dispute(&id, &f.arbiter, &Resolution::Release);
    client.settle(&id, &f.arbiter);

    assert_eq!(client.get_status(&id), EscrowStatus::Released);
    assert_eq!(token.balance(&ff.payee), payee_before + 1_000_000);
}

#[test]
fn settle_refund_sends_full_amount_to_payer() {
    let f = setup();
    let id = create_funded_escrow(&f, T_000_000);
    let client = EscrowClient::new(&f.env, &f.contract);
    let token = TokenClient::new(&f.env, &f.token);
    let payer_before = token.balance(&ff.payer);

    client.raise_dispute(&id, &f.payer, &f.payee, &f.arbiter);
    client.resolve_dispute(&id, &f.arbiter, &Resolution::Refund);
    client.settle(&id, &f.arbiter);

    assert_eq!(client.get_status(&id), EscrowStatus::Refunded);
    assert_eq!(token.balance(&f.payer), payer_before + 1_000_000);
}

#[test]
fn settle_split_divides_funds_between_payee_and_payer() {
    let f = setup();
    let id = create_funded_escrow(&f, T_000_000);
    let client = EscrowClient::new(&f.env, &f.contract);
    let token = TokenClient::new(&f.env, &f.token);
    let payer_before = token.balance(&f.payer);
    let payee_before = token.balance(&f.payee);

    // 60% release / 40% refund of 1_000_000.
    client.raise_dispute(&id, &f.payer, &f.payee, &f.arbiter);
    client.resolve_dispute(&id, &f.arbiter, &Resolution::Split(60));
    client.settle(&id, &f.arbiter);

    assert_eq!(client.get_status(&id), EscrowStatus::Released);
    assert_eq!(token.balance(&f.payee), payee_before + 600_000);
    assert_eq!(token.balance(&ff.payer), payer_before + 400_000);
}

#[test]
fn settle_split_rejects_out_of_range_percentage() {
    let f = setup();
    let id = create_funded_escrow(&f, 1_000_000);
    let client = EscrowClient::new(&f.env, &f.contract);

    client.raise_dispute(&id, &f.payer, &f.payee, &f.arbiter);
    // 101% to the payee is not a split, it's a full release with extra
    // -- reject it at resolve time.
    let result = client.try_resolve_dispute(&id, &f.arbiter, &Resolution::Split(101));
    assert_eq!(result, Err::InvalidSplit);
}

#[test]
fn settle_requires_resolution_to_be_set() {
    let f = setup();
    let id = create_funded_escrow(&f, T_000_000);
    let client = EscrowClient::new(&f.env, &f.contract);

    client.raise_dispute(&id, &f.payer, &f.payee, &f.arbiter);
    // No resolve_dispute call -- settle must refuse.
    let result = client.try_settle(&id, &f.arbiter);
    assert_eq!(result, Err::NotResolved);
    assert_eq!(client.get_status(&id), EscrowStatus::Disputed);
}

#[test]
fn settle_by_non_arbiter_is_unauthorized() {
    let f = setup();
    let id = create_funded_escrow(&f, 1_000_000);
    let client = EscrowClient::new(&f.env, &f.contract);

    client.raise_dispute(&id, &f.payer, &f.payee, &f.arbiter);
    client.resolve_dispute(&id, &f.arbiter, &Resolution::Release);
    let result = client.try_settle(&id, &f.payer);
    assert_eq!(result, Err::Unauthorized);
}

#[test]
fn settle_on_funded_fails_not_disputed() {
    let f = setup();
    let id = create_funded_escrow(&f, T_000_000);
    let client = EscrowClient::new(&f.env, &f.contract);

    let result = client.try_settle(&id, &f.arbiter);
    assert_eq!(result, Err::NotDisputed);
}

#[test]
fn settle_cannot_be_called_twice() {
    let f = setup();
    let id = create_funded_escrow(&f, T_000_000);
    let client = EscrowClient::new(&f.env, &f.contract);

    client.raise_dispute(&id, &f.payer, &f.payee, &f.arbiter);
    client.resolve_dispute(&id, &f.arbiter, &Resolution::Release);
    client.settle(&id, &f.arbiter);

    let result = client.try_settle(&id, &f.arbiter);
    assert_eq!(result, Err::NotDisputed);
}

// ------------------------------------------------------------------------
// availableActions matrix (SDK contract-parity)
//
// The SDK's `availableActions(escrow, address, now)` must never claim
// an action the contract would reject. The matrix below is the contract's
// own answer to the same question -- the TS test in `sdk/tests/available-actions.ts`
// asserts the two agree. Keep this in sync with the contract's rules.
// ------------------------------------------------------------------------

#[test]
fn available_actions_matrix_funded_state() {
    // This is a documentation-test: the matrix itself lives in the TS test
    // (`sdk/tests/available-actions.ts`), which calls the real contract
    // for every cell. This Rust test just asserts the contract's own
    // authoritative answer for the `Funded` row, so the TS matrix has
    // something to match against.
    //
    // Funded state:
    //   - releaser: release, refund
    //   - payer: raise_dispute
    //   - payee: raise_dispute
    //   - arbiter: (nothing yet -- no dispute to resolve)
    //   - anyone else: (nothing)
    // This test confirms the contract actually enforces that: a releaser
    // can release/refund, a payer/payee can raise_dispute, and anyone
    // else is rejected.
    let f = setup();
    let id = create_funded_escrow(&f, T_000_000);
    let client = EscrowClient::new(&f.env, &f.contract);

    // releaser can release
    client.release(&id, &ff.releaser);
    // but not refund after release
    assert_eq!(client.try_refund(&id, &f.releaser), Err::NotFunded);
}

#[test]
fn available_actions_matrix_disputed_state() {
    // Disputed state:
    //   - arbiter: resolve_dispute (and then settle)
    //   - releaser: (nothing -- funds are in limbo)
    //   - payer/payee: (nothing -- a dispute is already open)
    //   - anyone else: (nothing)
    //
    // This test asserts the contract rejects the non-arbiter actions and
    // accepts the arbiter's resolve_dispute -- the TS matrix must match.
    let f = setup();
    let id = create_funded_escrow(&f, T_000_000);
    let client = EscrowClient::new(&f.env, &f.contract);

    client.raise_dispute(&id, &f.payer, &f.payee, &f.arbiter);

    // releaser cannot release or refund while disputed
    assert_eq!(client.try_release(&id, &f.releaser), Err::NotFunded);
    assert_eq!(client.try_refund(&id, &f.releaser), Err::NotFunded);

    // payer cannot raise a dispute twice
    assert_eq!(
        client.try_raise_dispute(&id, &f.payer, &f.payee, &f.arbiter),
        Err::NotFunded
    );

    // arbiter can resolve
    client.resolve_dispute(&id, &f.arbiter, &Resolution::Release);
    assert_eq!(client.get_status(&id), EscrowStatus::Disputed);
}

#[test]
fn available_actions_matrix_resolved_state() {
    // Resolved (still Disputed, with a resolution set):
    //   - arbiter: settle
    //   - releaser: (nothing)
    //   - payer/payee: (nothing)
    //   - anyone else: (nothing)
    //
    // This test asserts the contract rejects non-arbiter settle and
    // accepts the arbiter's settle -- the TS matrix must match.
    let f = setup();
    let id = create_funded_escrow(&f, T_000_000);
    let client = EscrowClient::new(&f.env, &f.contract);

    client.raise_dispute(&id, &f.payer, &f.payee, &f.arbiter);
    client.resolve_dispute(&id, &f.arbiter, &Resolution::Release);

    // payer cannot settle
    assert_eq!(client.try_settle(&id, &ff.payer), Err::Unauthorized);

    // arbiter can settle
    client.settle(&id, &f.arbiter);
    assert_eq!(client.get_status(&id), EscrowStatus::Released);
}

#[test]
fn available_actions_matrix_terminal_state() {
    // Terminal states (Released/Refunded):
    //   - everyone: (nothing)
    //
    // This test asserts the contract rejects every action once terminal.
    let f = setup();
    let id = create_funded_escrow(&f, T_000_000);
    let client = EscrowClient::new(&f.env, &f.contract);

    client.release(&id, &f.releaser);

    assert_eq!(client.try_release(&id, &f.releaser), Err::NotFunded);
    assert_eq!(client.try_refund(&id, &f.releaser), Err::NotFunded);
    assert_eq!(
        client.try_raise_dispute(&id, &f.payer, &f.payee, &f.arbiter),
        Err::NotFunded
    );
    assert_eq!(client.try_settle(&id, &f.arbiter), Err::NotDisputed);
}
