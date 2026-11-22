// Issue #311: checked i128 arithmetic must behave at the largest representable
// token amount, and rejected operations must not change escrow state.

use docforum_escrow::{Error, EscrowContract, EscrowContractClient, EscrowStatus, MAX_FEE_BPS};
use soroban_sdk::{
    contract, contractimpl, contracttype,
    testutils::{Address as _, Ledger as _},
    Address, Env, String, Vec,
};

const MAX: i128 = i128::MAX;

#[contracttype]
#[derive(Clone)]
enum TokenKey {
    Balance(Address),
}

fn token_balance(env: &Env, address: &Address) -> i128 {
    env.storage()
        .persistent()
        .get(&TokenKey::Balance(address.clone()))
        .unwrap_or(0)
}

#[contract]
struct BoundaryToken;

#[contractimpl]
impl BoundaryToken {
    pub fn set_balance(env: Env, address: Address, amount: i128) {
        env.storage()
            .persistent()
            .set(&TokenKey::Balance(address), &amount);
    }

    pub fn balance(env: Env, address: Address) -> i128 {
        token_balance(&env, &address)
    }

    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        let from_balance = token_balance(&env, &from);
        let to_balance = token_balance(&env, &to);
        env.storage().persistent().set(
            &TokenKey::Balance(from),
            &from_balance.checked_sub(amount).unwrap(),
        );
        env.storage().persistent().set(
            &TokenKey::Balance(to),
            &to_balance.checked_add(amount).unwrap(),
        );
    }
}

#[contracttype]
#[derive(Clone)]
enum ScriptedKey {
    BalanceReads,
}

/// Reports a balance sequence that lets the escrow's exact-delta check pass
/// while keeping the token balance below i128::MAX. This isolates the
/// liability-counter overflow from a token balance overflow.
#[contract]
struct LiabilityOverflowToken;

#[contractimpl]
impl LiabilityOverflowToken {
    pub fn balance(env: Env, _address: Address) -> i128 {
        let read: u32 = env
            .storage()
            .persistent()
            .get(&ScriptedKey::BalanceReads)
            .unwrap_or(0);
        env.storage()
            .persistent()
            .set(&ScriptedKey::BalanceReads, &(read + 1));
        match read {
            0 => 0,
            1 => MAX,
            2 => MAX - 1,
            3 => MAX,
            _ => MAX,
        }
    }

    pub fn transfer(_env: Env, _from: Address, _to: Address, _amount: i128) {}
}

fn deploy(env: &Env) -> (Address, EscrowContractClient<'_>) {
    let id = env.register(
        EscrowContract,
        (Vec::<Address>::new(env), Address::generate(env)),
    );
    (id.clone(), EscrowContractClient::new(env, &id))
}

fn parties(env: &Env) -> (Address, Address, Address) {
    (
        Address::generate(env),
        Address::generate(env),
        Address::generate(env),
    )
}

fn create_args<'a>(
    env: &'a Env,
    client: &EscrowContractClient<'a>,
    token: &Address,
    payer: &Address,
    payee: &Address,
    releaser: &Address,
    amount: i128,
) -> u64 {
    client.create_escrow(
        payer,
        payee,
        token,
        &amount,
        &String::from_str(env, "i128-boundary"),
        releaser,
        &None,
        &false,
        &None,
        &None,
        &None,
    )
}

#[test]
fn creation_and_settlement_support_i128_max_and_exact_liability_subtraction() {
    let env = Env::default();
    env.mock_all_auths();
    let token_id = env.register(BoundaryToken, ());
    let token = BoundaryTokenClient::new(&env, &token_id);
    let (payer, payee, releaser) = parties(&env);
    token.set_balance(&payer, &MAX);
    let (contract_id, client) = deploy(&env);

    let id = create_args(&env, &client, &token_id, &payer, &payee, &releaser, MAX);
    assert_eq!(client.get_escrow(&id).amount, MAX);
    assert_eq!(client.solvency(&token_id), (MAX, MAX));

    client.release(&id, &releaser);
    assert_eq!(token.balance(&contract_id), 0);
    assert_eq!(token.balance(&payee), MAX);
    assert_eq!(client.solvency(&token_id), (0, 0));
    assert_eq!(client.get_status(&id), EscrowStatus::Released);
}

#[test]
fn second_max_boundary_creation_rejects_liability_overflow_without_state_change() {
    let env = Env::default();
    env.mock_all_auths();
    let token_id = env.register(LiabilityOverflowToken, ());
    let (payer, payee, releaser) = parties(&env);
    let (contract_id, client) = deploy(&env);

    let first = create_args(&env, &client, &token_id, &payer, &payee, &releaser, MAX);
    let rejected = client.try_create_escrow(
        &payer,
        &payee,
        &token_id,
        &1,
        &String::from_str(&env, "i128-boundary-second"),
        &releaser,
        &None,
        &false,
        &None,
        &None,
        &None,
    );

    assert_eq!(rejected, Err(Ok(Error::Overflow)));
    assert_eq!(client.get_escrow(&first).amount, MAX);
    // The scripted token's read cursor rolls back with the rejected
    // invocation, so use the liability component for the unchanged-state
    // assertion; the first escrow and its MAX liability are authoritative.
    assert_eq!(client.solvency(&token_id).1, MAX);
    assert_eq!(client.try_get_status(&1), Err(Ok(Error::NotFound)));
    assert_eq!(contract_id, client.address);
}

#[test]
fn top_up_reaches_i128_max_and_overflowing_retry_is_atomic() {
    let env = Env::default();
    env.mock_all_auths();
    let token_id = env.register(BoundaryToken, ());
    let token = BoundaryTokenClient::new(&env, &token_id);
    let (payer, payee, releaser) = parties(&env);
    token.set_balance(&payer, &MAX);
    let (contract_id, client) = deploy(&env);
    let id = create_args(&env, &client, &token_id, &payer, &payee, &releaser, 1);

    client.top_up(&id, &payer, &(MAX - 1));
    assert_eq!(client.get_escrow(&id).amount, MAX);
    assert_eq!(client.solvency(&token_id), (MAX, MAX));
    assert_eq!(token.balance(&payer), 0);

    assert_eq!(client.try_top_up(&id, &payer, &1), Err(Ok(Error::Overflow)));
    assert_eq!(client.get_escrow(&id).amount, MAX);
    assert_eq!(client.solvency(&token_id), (MAX, MAX));
    assert_eq!(token.balance(&contract_id), MAX);
}

#[test]
fn fee_math_accepts_the_largest_non_overflowing_scaled_amount() {
    let env = Env::default();
    env.mock_all_auths();
    let token_id = env.register(BoundaryToken, ());
    let token = BoundaryTokenClient::new(&env, &token_id);
    let (payer, payee, releaser) = parties(&env);
    let fee_recipient = Address::generate(&env);
    let amount = MAX / i128::from(MAX_FEE_BPS);
    token.set_balance(&payer, &amount);
    let (_contract_id, client) = deploy(&env);

    let id = client.create_escrow(
        &payer,
        &payee,
        &token_id,
        &amount,
        &String::from_str(&env, "i128-fee-boundary"),
        &releaser,
        &None,
        &false,
        &None,
        &Some(fee_recipient.clone()),
        &Some(MAX_FEE_BPS),
    );
    client.release(&id, &releaser);

    let fee = amount * i128::from(MAX_FEE_BPS) / 10_000;
    assert_eq!(token.balance(&fee_recipient), fee);
    assert_eq!(token.balance(&payee), amount - fee);
    assert_eq!(
        token.balance(&fee_recipient) + token.balance(&payee),
        amount
    );
}

#[test]
fn fee_math_overflow_is_rejected_before_creation_transfer() {
    let env = Env::default();
    env.mock_all_auths();
    let token_id = env.register(BoundaryToken, ());
    let token = BoundaryTokenClient::new(&env, &token_id);
    let (payer, payee, releaser) = parties(&env);
    let fee_recipient = Address::generate(&env);
    token.set_balance(&payer, &MAX);
    let (contract_id, client) = deploy(&env);
    let amount = MAX / i128::from(MAX_FEE_BPS) + 1;

    assert_eq!(
        client.try_create_escrow(
            &payer,
            &payee,
            &token_id,
            &amount,
            &String::from_str(&env, "i128-fee-overflow"),
            &releaser,
            &None,
            &false,
            &None,
            &Some(fee_recipient),
            &Some(MAX_FEE_BPS),
        ),
        Err(Ok(Error::InvalidFee))
    );
    assert_eq!(token.balance(&payer), MAX);
    assert_eq!(token.balance(&contract_id), 0);
    assert_eq!(client.try_get_status(&0), Err(Ok(Error::NotFound)));
}

#[test]
fn pooled_contribute_and_claim_refund_support_i128_max() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);
    let token_id = env.register(BoundaryToken, ());
    let token = BoundaryTokenClient::new(&env, &token_id);
    let (creator, payee, releaser) = parties(&env);
    token.set_balance(&creator, &MAX);
    let (contract_id, client) = deploy(&env);
    let id = client.create_pooled_escrow(
        &creator,
        &payee,
        &token_id,
        &MAX,
        &String::from_str(&env, "i128-pooled-boundary"),
        &releaser,
        &2_000,
    );

    client.contribute(&id, &creator, &MAX);
    assert_eq!(client.get_escrow(&id).amount, MAX);
    assert_eq!(client.solvency(&token_id), (MAX, MAX));
    env.ledger().set_timestamp(2_000);
    assert_eq!(
        client.try_claim_refund(&id, &creator),
        Err(Ok(Error::FundingTargetReached))
    );

    // A fully funded pool cannot enter the failed-round claim path, so
    // release exercises the exact MAX liability subtraction instead.
    client.release(&id, &releaser);
    assert_eq!(client.solvency(&token_id), (0, 0));
    assert_eq!(token.balance(&contract_id), 0);
    assert_eq!(token.balance(&payee), MAX);

    // A failed round exercises the checked subtraction in `claim_refund` at
    // a near-maximum contribution, after the same liability counter has
    // already handled an exact MAX amount.
    let contributor = Address::generate(&env);
    token.set_balance(&contributor, &MAX);
    let failed_id = client.create_pooled_escrow(
        &creator,
        &payee,
        &token_id,
        &MAX,
        &String::from_str(&env, "i128-claim-boundary"),
        &releaser,
        &3_000,
    );
    let contribution = MAX - 1;
    client.contribute(&failed_id, &contributor, &contribution);
    assert_eq!(client.solvency(&token_id), (contribution, contribution));
    env.ledger().set_timestamp(3_000);
    client.claim_refund(&failed_id, &contributor);
    assert_eq!(client.solvency(&token_id), (0, 0));
    assert_eq!(token.balance(&contributor), MAX);
}
