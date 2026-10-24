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

use docforum_escrow::{Error, EscrowContract, EscrowContractClient, EscrowStatus};
use soroban_sdk::{
    contract, contractimpl, contracttype,
    testutils::{Address as _, Ledger as _},
    Address, Env, String, Vec,
};

#[contracttype]
#[derive(Clone)]
enum MockKey {
    Balance(Address),
    AttackEscrow,
    AttackId,
    AttackCaller,
    PayoutBlocked,
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
        env.storage()
            .persistent()
            .set(&MockKey::AttackEscrow, &escrow);
        env.storage()
            .persistent()
            .set(&MockKey::AttackId, &escrow_id);
        env.storage()
            .persistent()
            .set(&MockKey::AttackCaller, &caller);
    }

    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        mock_debit_credit(&env, &from, &to, amount, amount);

        // Inert until armed; once armed, the re-entry fires when the
        // escrow contract's outbound transfer flows through here.
        let attack_escrow: Option<Address> = env.storage().persistent().get(&MockKey::AttackEscrow);
        if let Some(attack_escrow) = attack_escrow {
            if from == attack_escrow {
                let escrow_id: u64 = env.storage().persistent().get(&MockKey::AttackId).unwrap();
                let caller: Address = env
                    .storage()
                    .persistent()
                    .get(&MockKey::AttackCaller)
                    .unwrap();
                let client = EscrowContractClient::new(&env, &attack_escrow);
                // Re-entry attempt: the escrow contract is already on
                // the call stack. Whatever the host does with this
                // call, a second payout must be impossible.
                client.release(&escrow_id, &caller);
            }
        }
    }
}

// --- FailingPayoutToken: honest funding, panics on an outbound payout ---

#[contract]
pub struct FailingPayoutToken;

#[contractimpl]
impl FailingPayoutToken {
    pub fn set_balance(env: Env, id: Address, amount: i128) {
        env.storage()
            .persistent()
            .set(&MockKey::Balance(id), &amount);
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        mock_balance(&env, &id)
    }

    pub fn arm(env: Env) {
        env.storage()
            .persistent()
            .set(&MockKey::PayoutBlocked, &true);
    }

    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        let armed: bool = env
            .storage()
            .persistent()
            .get(&MockKey::PayoutBlocked)
            .unwrap_or(false);
        if armed {
            panic!("payout blocked");
        }
        mock_debit_credit(&env, &from, &to, amount, amount);
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
    let contract_id = env.register(
        EscrowContract,
        (Vec::<Address>::new(&env), Address::generate(&env)),
    );
    let client = EscrowContractClient::new(&env, &contract_id);

    let result = client.try_create_escrow(
        &payer,
        &payee,
        &token_id,
        &300,
        &String::from_str(&env, "opaque-condition-ref"),
        &releaser,
        &None,
        &false,
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
    let contract_id = env.register(
        EscrowContract,
        (Vec::<Address>::new(&env), Address::generate(&env)),
    );
    let client = EscrowContractClient::new(&env, &contract_id);

    let result = client.try_create_escrow(
        &payer,
        &payee,
        &token_id,
        &300,
        &String::from_str(&env, "opaque-condition-ref"),
        &releaser,
        &None,
        &false,
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
fn failed_payout_leaves_the_escrow_funded() {
    let env = Env::default();
    env.mock_all_auths();

    // Checks-effects-interactions (docs/adr/0006): `release` now writes the
    // settled status before calling the token. A payout that fails must roll
    // that write back, never leaving an escrow `Released` with the funds
    // still in the contract.
    let token_id = env.register(FailingPayoutToken, ());
    let token = FailingPayoutTokenClient::new(&env, &token_id);
    let payer = Address::generate(&env);
    token.set_balance(&payer, &1_000);

    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    let contract_id = env.register(
        EscrowContract,
        (Vec::<Address>::new(&env), Address::generate(&env)),
    );
    let client = EscrowContractClient::new(&env, &contract_id);

    let escrow_id = client.create_escrow(
        &payer,
        &payee,
        &token_id,
        &300,
        &String::from_str(&env, "opaque-condition-ref"),
        &releaser,
        &None,
        &false,
        &None,
    );

    token.arm();
    assert!(client.try_release(&escrow_id, &releaser).is_err());

    assert_eq!(client.get_status(&escrow_id), EscrowStatus::Funded);
    assert_eq!(token.balance(&contract_id), 300);
    assert_eq!(token.balance(&payee), 0);
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
    let contract_id = env.register(
        EscrowContract,
        (Vec::<Address>::new(&env), Address::generate(&env)),
    );
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
        &false,
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

// --- pooled contributions face the same balance-delta check (issue #113) ---

fn pooled_id(
    client: &EscrowContractClient,
    env: &Env,
    token_id: &Address,
    creator: &Address,
    payee: &Address,
    releaser: &Address,
    target: i128,
) -> u64 {
    client.create_pooled_escrow(
        creator,
        payee,
        token_id,
        &target,
        &String::from_str(env, "pooled-malicious-token"),
        releaser,
        &(env.ledger().timestamp() + 1_000),
    )
}

#[test]
fn contribute_rejects_lying_transfer() {
    // A lying token funds a pooled escrow's creation happily (nothing is
    // transferred there), but `contribute` verifies the balance delta and
    // must record nothing when the tokens never arrive (invariant I4).
    let env = Env::default();
    env.mock_all_auths();

    let token_id = env.register(LyingToken, ());
    let token = LyingTokenClient::new(&env, &token_id);
    let payer = Address::generate(&env);
    token.set_balance(&payer, &1_000);

    let creator = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    let contract_id = env.register(
        EscrowContract,
        (Vec::<Address>::new(&env), Address::generate(&env)),
    );
    let client = EscrowContractClient::new(&env, &contract_id);

    let escrow_id = pooled_id(&client, &env, &token_id, &creator, &payee, &releaser, 300);

    let result = client.try_contribute(&escrow_id, &payer, &100);

    assert_eq!(result, Err(Ok(Error::BalanceMismatch)));
    assert_eq!(token.balance(&payer), 1_000);
    assert_eq!(token.balance(&contract_id), 0);
    assert!(client.get_contribution(&escrow_id, &payer).is_none());
    assert_eq!(client.get_escrow(&escrow_id).amount, 0);
}

#[test]
fn contribute_rejects_short_delivery() {
    // Fee-on-transfer shape: 100 debited, only 90 delivered. The
    // contribution must fail entirely — the escrow cannot owe more than
    // it holds — and the token's own debit rolls back with it.
    let env = Env::default();
    env.mock_all_auths();

    let token_id = env.register(FeeOnTransferToken, ());
    let token = FeeOnTransferTokenClient::new(&env, &token_id);
    let payer = Address::generate(&env);
    token.set_balance(&payer, &1_000);

    let creator = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    let contract_id = env.register(
        EscrowContract,
        (Vec::<Address>::new(&env), Address::generate(&env)),
    );
    let client = EscrowContractClient::new(&env, &contract_id);

    let escrow_id = pooled_id(&client, &env, &token_id, &creator, &payee, &releaser, 300);

    let result = client.try_contribute(&escrow_id, &payer, &100);

    assert_eq!(result, Err(Ok(Error::BalanceMismatch)));
    assert_eq!(token.balance(&payer), 1_000);
    assert_eq!(token.balance(&contract_id), 0);
    assert!(client.get_contribution(&escrow_id, &payer).is_none());
    assert_eq!(client.get_escrow(&escrow_id).amount, 0);
}

#[test]
fn failed_claim_leaves_the_contribution_intact() {
    // Checks-effects-interactions on the pull-refund path (issue #113):
    // a claim whose outbound transfer panics must roll back the
    // `refunded` flag and the pooled total, never marking a contribution
    // spent while its tokens never moved.
    let env = Env::default();
    env.mock_all_auths();

    let token_id = env.register(FailingPayoutToken, ());
    let token = FailingPayoutTokenClient::new(&env, &token_id);
    let payer = Address::generate(&env);
    token.set_balance(&payer, &1_000);

    let creator = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    let contract_id = env.register(
        EscrowContract,
        (Vec::<Address>::new(&env), Address::generate(&env)),
    );
    let client = EscrowContractClient::new(&env, &contract_id);

    let escrow_id = pooled_id(&client, &env, &token_id, &creator, &payee, &releaser, 300);
    // Honest funding in; only the outbound payout leg is armed later.
    client.contribute(&escrow_id, &payer, &300);
    token.arm();

    // Miss the funding target's window: the round failed and claims open.
    env.ledger().set_timestamp(env.ledger().timestamp() + 2_000);

    assert!(client.try_claim_refund(&escrow_id, &payer).is_err());

    // Accounting untouched: still unclaimed, still fully held.
    assert_eq!(client.get_status(&escrow_id), EscrowStatus::Funded);
    assert_eq!(client.get_escrow(&escrow_id).amount, 300);
    assert_eq!(token.balance(&contract_id), 300);
    assert_eq!(token.balance(&payer), 700);
    let record = client.get_contribution(&escrow_id, &payer).unwrap();
    assert!(!record.refunded);
}
