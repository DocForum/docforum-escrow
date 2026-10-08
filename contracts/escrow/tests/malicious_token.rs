// Phase E4 tests (issue #12) — non-standard and malicious tokens.
// Per AGENTS.md hard rule 2: contract logic changes need tests here in
// the same PR.
//
// Three test-only mock tokens, each misbehaving in a specific way:
// - `LyingToken`: `transfer` reports success and moves nothing (T5).
// - `FeeOnTransferToken`: debits the full amount but delivers only 90%
//   — the fee-on-transfer shape (T5).
// - `ReentrantToken`: from inside `transfer`, calls back into the
//   escrow contract's `release` while it is still executing (T4).
//
// The escrow contract trusts `token` to behave like a standard SEP-41
// token (threat model T5). All escrows in one token share the
// contract's balance, so `create_escrow` verifies the balance rises by
// exactly `amount` and rejects the escrow otherwise.

use docforum_escrow::{EscrowContract, EscrowContractClient, Error};
use soroban_sdk::{
    contract, contractimpl, contracttype,
    testutils::Address as _,
    Address, Env, String,
};

#[contracttype]
#[derive(Clone)]
enum MockKey {
    Balance(Address),
    AttackEscrow,
    AttackId,
    AttackCaller,
}

fn mock_balance(env: &Env, id: &Address) -> i128 {
    env.storage()
        .persistent()
        .get(&MockKey::Balance(id.clone()))
        .unwrap_or(0)
}

fn mock_debit_credit(env: &Env, from: &Address, to: &Address, amount: i128, delivered: i128) {
    let from_bal = mock_balance(env, from);
    let to_bal = mock_balance(env, to);
    env.storage()
        .persistent()
        .set(&MockKey::Balance(from.clone()), &(from_bal - amount));
    env.storage()
        .persistent()
        .set(&MockKey::Balance(to.clone()), &(to_bal + delivered));
}

// --- LyingToken: transfer succeeds and moves nothing ---

#[contract]
pub struct LyingToken;

#[contractimpl]
impl LyingToken {
    pub fn set_balance(env: Env, id: Address, amount: i128) {
        env.storage()
            .persistent()
            .set(&MockKey::Balance(id), &amount);
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        mock_balance(&env, &id)
    }

    // The lie: reports success, moves nothing.
    pub fn transfer(_env: Env, _from: Address, _to: Address, _amount: i128) {}
}

// --- FeeOnTransferToken: debits `amount`, delivers 90% ---

#[contract]
pub struct FeeOnTransferToken;

#[contractimpl]
impl FeeOnTransferToken {
    pub fn set_balance(env: Env, id: Address, amount: i128) {
        env.storage()
            .persistent()
            .set(&MockKey::Balance(id), &amount);
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        mock_balance(&env, &id)
    }

    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        mock_debit_credit(&env, &from, &to, amount, amount * 9 / 10);
    }
}

// --- ReentrantToken: honest transfers, then re-enters `release` ---

#[contract]
pub struct ReentrantToken;

#[contractimpl]
impl ReentrantToken {
    pub fn set_balance(env: Env, id: Address, amount: i128) {
        env.storage()
            .persistent()
            .set(&MockKey::Balance(id), &amount);
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        mock_balance(&env, &id)
    }

    /// Points the token at the escrow it should attack. The re-entry
    /// fires when the escrow contract's outbound transfer flows through
    /// `transfer` — i.e. during `release`, not during `create_escrow`.
    pub fn arm(env: Env, escrow: Address, escrow_id: u64, caller: Address) {
        env.storage().persistent().set(&MockKey::AttackEscrow, &escrow);
        env.storage().persistent().set(&MockKey::AttackId, &escrow_id);
        env.storage().persistent().set(&MockKey::AttackCaller, &caller);
    }

    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        mock_debit_credit(&env, &from, &to, amount, amount);

        // Inert until armed; once armed, the re-entry fires when the
        // escrow contract's outbound transfer flows through here.
        let attack_escrow: Option<Address> =
            env.storage().persistent().get(&MockKey::AttackEscrow);
        if let Some(attack_escrow) = attack_escrow {
            if from == attack_escrow {
                let escrow_id: u64 =
                    env.storage().persistent().get(&MockKey::AttackId).unwrap();
                let caller: Address =
                    env.storage().persistent().get(&MockKey::AttackCaller).unwrap();
                let client = EscrowContractClient::new(&env, &attack_escrow);
                // Re-entry attempt: the escrow contract is already on
                // the call stack. Whatever the host does with this
                // call, a second payout must be impossible.
                client.release(&escrow_id, &caller);
            }
        }
    }
}

// --- tests ---

#[test]
fn create_escrow_rejects_lying_transfer() {
    let env = Env::default();
    env.mock_all_auths();

    let token_id = env.register(LyingToken, ());
    let token = LyingTokenClient::new(&env, &token_id);
    let payer = Address::generate(&env);
    token.set_balance(&payer, &1_000);

    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);

    let result = client.try_create_escrow(
        &payer,
        &payee,
        &token_id,
        &300,
        &String::from_str(&env, "opaque-condition-ref"),
        &releaser,
        &None,
    );

    assert_eq!(result, Err(Ok(Error::BalanceMismatch)));
    // Nothing was moved and no escrow exists.
    assert_eq!(token.balance(&payer), 1_000);
    assert!(matches!(
        client.try_get_status(&0),
        Err(Ok(Error::NotFound))
    ));
}

#[test]
fn create_escrow_rejects_short_delivery() {
    let env = Env::default();
    env.mock_all_auths();

    let token_id = env.register(FeeOnTransferToken, ());
    let token = FeeOnTransferTokenClient::new(&env, &token_id);
    let payer = Address::generate(&env);
    token.set_balance(&payer, &1_000);

    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);

    let result = client.try_create_escrow(
        &payer,
        &payee,
        &token_id,
        &300,
        &String::from_str(&env, "opaque-condition-ref"),
        &releaser,
        &None,
    );

    // 300 debited but only 270 delivered — the contract owes 300 and
    // holds 270, so the escrow must not exist.
    assert_eq!(result, Err(Ok(Error::BalanceMismatch)));
    assert_eq!(token.balance(&contract_id), 0);
    // The whole invocation rolled back, including the token's own
    // internal state change.
    assert_eq!(token.balance(&payer), 1_000);
}

#[test]
#[should_panic(expected = "Contract re-entry is not allowed")]
fn reentrant_transfer_cannot_double_release() {
    let env = Env::default();
    env.mock_all_auths();

    let token_id = env.register(ReentrantToken, ());
    let token = ReentrantTokenClient::new(&env, &token_id);
    let payer = Address::generate(&env);
    token.set_balance(&payer, &1_000);

    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);

    // Creating with this token is fine: the transfer in is honest, and
    // the re-entry only fires on the escrow contract's outbound flow.
    let escrow_id = client.create_escrow(
        &payer,
        &payee,
        &token_id,
        &300,
        &String::from_str(&env, "opaque-condition-ref"),
        &releaser,
        &None,
    );
    assert_eq!(token.balance(&contract_id), 300);

    token.arm(&contract_id, &escrow_id, &releaser);

    // Release pulls the escrow contract's balance down via `transfer`,
    // which re-enters `release` mid-flight. The host rejects re-entry
    // ("Contract re-entry is not allowed") as an unrecoverable error:
    // the trap aborts the whole invocation, so a second payout is
    // impossible and the escrow's state is reverted atomically — still
    // Funded, balances untouched, settleable later by an honest path.
    // (The mock propagates the inner failure rather than swallowing
    // it; a swallowing token would only spare itself the DoS.)
    client.release(&escrow_id, &releaser);
}
