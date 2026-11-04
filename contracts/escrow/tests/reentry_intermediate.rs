// Threat model T4 (issue #103): re-entry through an intermediate contract.
//
// `tests/malicious_token.rs` pins the direct token -> escrow path. Here the
// malicious token instead calls a helper contract from inside `transfer`, and
// the helper calls the escrow: token -> helper -> escrow. Every auth is mocked,
// so only the host's re-entry check can stop these calls.
//
// Each call must fail closed: the outer call fails, no funds move, and the escrow
// keeps its status. `release` reports `Undeliverable`, because it catches a failed
// payout. `refund` and `create_escrow` abort. The two tests at the end are controls
// showing the same attack works when nothing is re-entrant.

use docforum_escrow::{Error, EscrowContract, EscrowContractClient, EscrowStatus};
use soroban_sdk::{
    contract, contractimpl, contracttype, testutils::Address as _, Address, Env, IntoVal,
    InvokeError, String, Symbol, Vec,
};

#[contracttype]
#[derive(Clone)]
enum Key {
    Balance(Address),
    Armed,
}

#[contracttype]
#[derive(Clone, Copy, PartialEq)]
pub enum Move {
    Release,
    Refund,
    Create,
}

/// What the helper should attempt, stored in the token by `arm`.
#[contracttype]
#[derive(Clone)]
pub struct Attack {
    pub helper: Address,
    pub escrow: Address,
    pub kind: Move,
    pub escrow_id: u64,
    pub caller: Address,
    pub token: Address,
}

#[contract]
pub struct RelayingToken;

#[contractimpl]
impl RelayingToken {
    pub fn set_balance(env: Env, id: Address, amount: i128) {
        env.storage().persistent().set(&Key::Balance(id), &amount);
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&Key::Balance(id))
            .unwrap_or(0)
    }

    pub fn arm(env: Env, attack: Attack) {
        env.storage().instance().set(&Key::Armed, &attack);
    }

    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        let from_balance = Self::balance(env.clone(), from.clone());
        let to_balance = Self::balance(env.clone(), to.clone());
        env.storage()
            .persistent()
            .set(&Key::Balance(from), &(from_balance - amount));
        env.storage()
            .persistent()
            .set(&Key::Balance(to), &(to_balance + amount));

        let armed: Option<Attack> = env.storage().instance().get(&Key::Armed);
        if let Some(attack) = armed {
            env.storage().instance().remove(&Key::Armed);
            let helper = attack.helper.clone();
            env.invoke_contract::<()>(
                &helper,
                &Symbol::new(&env, "relay"),
                (attack,).into_val(&env),
            );
        }
    }
}

#[contract]
pub struct RelayHelper;

#[contractimpl]
impl RelayHelper {
    /// The intermediate hop: calls back into the escrow on the token's behalf.
    pub fn relay(env: Env, attack: Attack) {
        let escrow = EscrowContractClient::new(&env, &attack.escrow);
        match attack.kind {
            Move::Release => escrow.release(&attack.escrow_id, &attack.caller),
            Move::Refund => escrow.refund(&attack.escrow_id, &attack.caller),
            Move::Create => {
                escrow.create_escrow(
                    &attack.caller,
                    &attack.caller,
                    &attack.token,
                    &100,
                    &String::from_str(&env, "reentry"),
                    &attack.caller,
                    &None,
                    &false,
                    &None,
                    &None,
                    &None,
                );
            }
        }
    }
}

struct Fixture<'a> {
    env: Env,
    client: EscrowContractClient<'a>,
    token: RelayingTokenClient<'a>,
    contract_id: Address,
    token_id: Address,
    helper_id: Address,
    payer: Address,
    payee: Address,
    releaser: Address,
}

fn setup<'a>() -> Fixture<'a> {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let token_id = env.register(RelayingToken, ());
    let helper_id = env.register(RelayHelper, ());
    let token = RelayingTokenClient::new(&env, &token_id);
    let payer = Address::generate(&env);
    token.set_balance(&payer, &1_000);
    let contract_id = env.register(
        EscrowContract,
        (Vec::<Address>::new(&env), Address::generate(&env)),
    );
    let client = EscrowContractClient::new(&env, &contract_id);
    Fixture {
        client,
        token,
        contract_id,
        token_id,
        helper_id,
        payer,
        payee: Address::generate(&env),
        releaser: Address::generate(&env),
        env,
    }
}

fn create(f: &Fixture, amount: i128) -> u64 {
    f.client.create_escrow(
        &f.payer,
        &f.payee,
        &f.token_id,
        &amount,
        &String::from_str(&f.env, "opaque-condition-ref"),
        &f.releaser,
        &None,
        &false,
        &None,
        &None,
        &None,
    )
}

fn arm(f: &Fixture, kind: Move, escrow_id: u64) {
    f.token.arm(&Attack {
        helper: f.helper_id.clone(),
        escrow: f.contract_id.clone(),
        kind,
        escrow_id,
        caller: f.releaser.clone(),
        token: f.token_id.clone(),
    });
}

/// `release` catches the failed transfer and reports `Undeliverable`.
fn assert_undeliverable<T: core::fmt::Debug, C: core::fmt::Debug>(
    result: Result<Result<T, C>, Result<Error, InvokeError>>,
) {
    assert!(
        matches!(result, Err(Ok(Error::Undeliverable))),
        "expected Undeliverable, got {result:?}"
    );
}

/// `refund` and `create_escrow` don't catch it, so the whole invocation aborts.
fn assert_aborted<T: core::fmt::Debug, C: core::fmt::Debug>(
    result: Result<Result<T, C>, Result<Error, InvokeError>>,
) {
    assert!(
        matches!(result, Err(Err(InvokeError::Abort))),
        "expected the invocation to abort, got {result:?}"
    );
}

fn assert_unchanged(f: &Fixture, escrow_id: u64, escrowed: i128, payer_balance: i128) {
    assert_eq!(f.client.get_status(&escrow_id), EscrowStatus::Funded);
    assert_eq!(f.token.balance(&f.contract_id), escrowed);
    assert_eq!(f.token.balance(&f.payee), 0);
    assert_eq!(f.token.balance(&f.payer), payer_balance);
}

#[test]
fn release_through_a_helper_cannot_release_again() {
    let f = setup();
    let id = create(&f, 300);
    arm(&f, Move::Release, id);
    assert_undeliverable(f.client.try_release(&id, &f.releaser));
    assert_unchanged(&f, id, 300, 700);
}

#[test]
fn refund_through_a_helper_during_release_is_rejected() {
    let f = setup();
    let id = create(&f, 300);
    arm(&f, Move::Refund, id);
    assert_undeliverable(f.client.try_release(&id, &f.releaser));
    assert_unchanged(&f, id, 300, 700);
}

#[test]
fn release_through_a_helper_during_refund_is_rejected() {
    let f = setup();
    let id = create(&f, 300);
    arm(&f, Move::Release, id);
    assert_aborted(f.client.try_refund(&id, &f.releaser));
    assert_unchanged(&f, id, 300, 700);
}

#[test]
fn create_through_a_helper_during_release_is_rejected() {
    let f = setup();
    let id = create(&f, 300);
    arm(&f, Move::Create, 0);
    assert_undeliverable(f.client.try_release(&id, &f.releaser));
    assert_unchanged(&f, id, 300, 700);
    assert!(f.client.try_get_status(&(id + 1)).is_err());
}

#[test]
fn a_helper_cannot_reach_a_different_escrow_during_release() {
    let f = setup();
    let first = create(&f, 300);
    let second = create(&f, 200);
    arm(&f, Move::Release, second);
    assert_undeliverable(f.client.try_release(&first, &f.releaser));
    assert_unchanged(&f, first, 500, 500);
    assert_eq!(f.client.get_status(&second), EscrowStatus::Funded);
}

#[test]
fn a_helper_cannot_release_another_escrow_during_create() {
    let f = setup();
    let existing = create(&f, 300);
    arm(&f, Move::Release, existing);
    assert_aborted(f.client.try_create_escrow(
        &f.payer,
        &f.payee,
        &f.token_id,
        &200,
        &String::from_str(&f.env, "opaque-condition-ref"),
        &f.releaser,
        &None,
        &false,
        &None,
        &None,
        &None,
    ));
    assert_unchanged(&f, existing, 300, 700);
    assert!(f.client.try_get_status(&(existing + 1)).is_err());
}

// Controls: these prove the attack code works when nothing is re-entrant, so the
// failures above come from the call stack, not from a broken helper.

#[test]
fn the_helper_can_release_when_called_directly() {
    let f = setup();
    let id = create(&f, 300);
    RelayHelperClient::new(&f.env, &f.helper_id).relay(&Attack {
        helper: f.helper_id.clone(),
        escrow: f.contract_id.clone(),
        kind: Move::Release,
        escrow_id: id,
        caller: f.releaser.clone(),
        token: f.token_id.clone(),
    });
    assert_eq!(f.client.get_status(&id), EscrowStatus::Released);
    assert_eq!(f.token.balance(&f.payee), 300);
}

#[test]
fn release_succeeds_when_the_token_is_not_armed() {
    let f = setup();
    let id = create(&f, 300);
    f.client.release(&id, &f.releaser);
    assert_eq!(f.client.get_status(&id), EscrowStatus::Released);
    assert_eq!(f.token.balance(&f.payee), 300);
}
