#![no_main]

use docforum_escrow::{Error, EscrowContract, EscrowContractClient, EscrowStatus};
use libfuzzer_sys::fuzz_target;
use soroban_sdk::{
    contract, contractimpl, contracttype,
    testutils::{Address as _, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    Address, Env, String, Vec,
};

const START_BALANCE: i128 = 10_000;
const MAX_STEPS: usize = 64;

#[contracttype]
#[derive(Clone)]
enum MockKey {
    Balance(Address),
    Mode,
}

#[contract]
struct MockToken;

#[contractimpl]
impl MockToken {
    pub fn set_mode(env: Env, mode: u32) {
        env.storage().instance().set(&MockKey::Mode, &mode);
    }

    pub fn mint(env: Env, to: Address, amount: i128) {
        let balance: i128 = env
            .storage()
            .persistent()
            .get(&MockKey::Balance(to.clone()))
            .unwrap_or(0);
        env.storage()
            .persistent()
            .set(&MockKey::Balance(to), &(balance + amount));
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&MockKey::Balance(id))
            .unwrap_or(0)
    }

    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        let mode: u32 = env.storage().instance().get(&MockKey::Mode).unwrap_or(0);
        if mode == 1 {
            return;
        }
        let from_balance = Self::balance(env.clone(), from.clone());
        let delivered = if mode == 2 { amount * 9 / 10 } else { amount };
        let to_balance = Self::balance(env.clone(), to.clone());
        env.storage()
            .persistent()
            .set(&MockKey::Balance(from), &(from_balance - amount));
        env.storage()
            .persistent()
            .set(&MockKey::Balance(to), &(to_balance + delivered));
    }
}

fn balance(env: &Env, token: &Address, owner: &Address, token_mode: u8) -> i128 {
    if token_mode == 0 {
        TokenClient::new(env, token).balance(owner)
    } else {
        MockTokenClient::new(env, token).balance(owner)
    }
}

fn run(input: &[u8]) {
    if input.len() < 3 {
        return;
    }
    let mut env = Env::default();
    env.set_config(soroban_sdk::testutils::EnvTestConfig {
        capture_snapshot_at_drop: false,
    });
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    let stranger = Address::generate(&env);
    let amount = i128::from(input[0] % 33);
    let deadline = if input[1] & 1 == 0 {
        None
    } else {
        Some(1_000 + u64::from(input[1] % 32))
    };
    let token_mode = input[2] % 4;

    let token_address = if token_mode == 0 {
        let admin = Address::generate(&env);
        let sac = env.register_stellar_asset_contract_v2(admin);
        StellarAssetClient::new(&env, &sac.address()).mint(&payer, &START_BALANCE);
        sac.address().clone()
    } else {
        let address = env.register(MockToken, ());
        let token = MockTokenClient::new(&env, &address);
        token.set_mode(&u32::from(token_mode - 1));
        token.mint(&payer, &START_BALANCE);
        address
    };

    let contract_id = env.register(
        EscrowContract,
        (Vec::<Address>::new(&env), Address::generate(&env)),
    );
    let client = EscrowContractClient::new(&env, &contract_id);
    let created = client.try_create_escrow(
        &payer,
        &payee,
        &token_address,
        &amount,
        &String::from_str(&env, "fuzz-sequence"),
        &releaser,
        &deadline,
        &false,
        &None,
        &None,
        &None,
    );

    let escrow_id = match created {
        Ok(Ok(id)) => id,
        Ok(Err(_)) | Err(_) => {
            assert_eq!(balance(&env, &token_address, &contract_id, token_mode), 0);
            assert_eq!(balance(&env, &token_address, &payee, token_mode), 0);
            assert_eq!(
                balance(&env, &token_address, &payer, token_mode),
                START_BALANCE
            );
            return;
        }
    };

    assert_eq!(client.get_status(&escrow_id), EscrowStatus::Funded);
    assert_eq!(client.get_escrow(&escrow_id).amount, amount);
    assert_eq!(
        balance(&env, &token_address, &contract_id, token_mode),
        amount
    );
    assert_eq!(
        balance(&env, &token_address, &payer, token_mode),
        START_BALANCE - amount
    );
    assert_eq!(balance(&env, &token_address, &payee, token_mode), 0);

    let mut now = 1_000u64;
    let mut phase = EscrowStatus::Funded;
    let mut released = 0i128;
    let mut refunded = 0i128;
    for step in input[3..].chunks(2).take(MAX_STEPS) {
        let op = step[0] % 4;
        let value = *step.get(1).unwrap_or(&0);
        match op {
            0 => {
                let jump = u64::from(value % 24);
                now = now.saturating_add(jump);
                env.ledger().set_timestamp(now);
            }
            1 => {
                let caller = if value & 1 == 0 { &releaser } else { &stranger };
                let result = client.try_release(&escrow_id, caller);
                if phase == EscrowStatus::Funded {
                    if caller == &releaser {
                        assert_eq!(result, Ok(Ok(())));
                        phase = EscrowStatus::Released;
                        released = amount;
                    } else {
                        assert_eq!(result, Err(Ok(Error::Unauthorized)));
                    }
                } else if caller == &releaser {
                    assert_eq!(result, Err(Ok(Error::NotFunded)));
                } else {
                    assert_eq!(result, Err(Ok(Error::Unauthorized)));
                }
            }
            _ => {
                let caller = if value & 1 == 0 { &releaser } else { &stranger };
                let timeout_open = deadline.map(|d| now >= d).unwrap_or(false);
                let result = client.try_refund(&escrow_id, caller);
                if phase == EscrowStatus::Funded {
                    if caller == &releaser || timeout_open {
                        assert_eq!(result, Ok(Ok(())));
                        phase = EscrowStatus::Refunded;
                        refunded = amount;
                    } else {
                        assert_eq!(result, Err(Ok(Error::Unauthorized)));
                    }
                } else if caller == &releaser || timeout_open {
                    assert_eq!(result, Err(Ok(Error::NotFunded)));
                } else {
                    assert_eq!(result, Err(Ok(Error::Unauthorized)));
                }
            }
        }

        let record = client.get_escrow(&escrow_id);
        assert_eq!(record.status, phase);
        assert_eq!(record.amount, amount);
        assert_eq!(
            balance(&env, &token_address, &contract_id, token_mode),
            if phase == EscrowStatus::Funded {
                amount
            } else {
                0
            }
        );
        assert_eq!(balance(&env, &token_address, &payee, token_mode), released);
        assert_eq!(
            balance(&env, &token_address, &payer, token_mode),
            START_BALANCE - amount + refunded
        );
        assert_eq!(balance(&env, &token_address, &releaser, token_mode), 0);
        assert_eq!(balance(&env, &token_address, &stranger, token_mode), 0);
        assert!(released == 0 || refunded == 0);
    }
}

fuzz_target!(|data: &[u8]| run(data));
