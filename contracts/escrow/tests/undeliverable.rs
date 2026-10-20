use docforum_escrow::{Error, EscrowContract, EscrowContractClient, EscrowStatus};
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short,
    testutils::{Address as _, IssuerFlags},
    token::{StellarAssetClient, TokenClient},
    Address, Env, String,
};

#[test]
fn unauthorized_sac_payee_leaves_escrow_funded_and_can_be_retried() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(admin);
    token_id.issuer().set_flag(IssuerFlags::RevocableFlag);
    let token = TokenClient::new(&env, &token_id.address());
    let asset = StellarAssetClient::new(&env, &token_id.address());
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    asset.mint(&payer, &1_000);

    let contract_id = env.register(EscrowContract, (soroban_sdk::Vec::<Address>::new(&env),));
    let client = EscrowContractClient::new(&env, &contract_id);
    let escrow_id = client.create_escrow(
        &payer,
        &payee,
        &token_id.address(),
        &300,
        &String::from_str(&env, "undeliverable-sac-payee"),
        &releaser,
        &None,
        &false,
    );

    // This uses the SAC's actual authorization flag, rather than a mock
    // token return value. A deauthorized destination rejects transfer.
    asset.set_authorized(&payee, &false);
    let rejected = client.try_release(&escrow_id, &releaser);
    assert_eq!(rejected, Err(Ok(Error::Undeliverable)));
    assert_eq!(client.get_status(&escrow_id), EscrowStatus::Funded);
    assert_eq!(token.balance(&contract_id), 300);
    assert_eq!(token.balance(&payee), 0);

    asset.set_authorized(&payee, &true);
    client.release(&escrow_id, &releaser);
    assert_eq!(client.get_status(&escrow_id), EscrowStatus::Released);
    assert_eq!(token.balance(&payee), 300);
}

#[contract]
struct RejectingPayee;

#[contractimpl]
impl RejectingPayee {
    pub fn receive(_env: Env) {
        panic!("payee rejected transfer");
    }
}

#[contracttype]
#[derive(Clone)]
enum CallbackTokenKey {
    Balance(Address),
    Escrow(Address),
}

fn callback_balance(env: &Env, address: &Address) -> i128 {
    env.storage()
        .persistent()
        .get(&CallbackTokenKey::Balance(address.clone()))
        .unwrap_or(0)
}

#[contract]
struct CallbackToken;

#[contractimpl]
impl CallbackToken {
    pub fn set_balance(env: Env, address: Address, amount: i128) {
        env.storage()
            .persistent()
            .set(&CallbackTokenKey::Balance(address), &amount);
    }

    pub fn set_escrow(env: Env, escrow: Address) {
        env.storage()
            .persistent()
            .set(&CallbackTokenKey::Escrow(escrow), &());
    }

    pub fn balance(env: Env, address: Address) -> i128 {
        callback_balance(&env, &address)
    }

    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        // When funds are sent out of the escrow, model a token/receiver
        // integration that calls the contract payee and propagates its
        // rejection. The outer escrow call must recover this failure.
        if env
            .storage()
            .persistent()
            .has(&CallbackTokenKey::Escrow(from.clone()))
        {
            let _: () =
                env.invoke_contract(&to, &symbol_short!("receive"), soroban_sdk::vec![&env]);
        } else if from != to {
            // Inbound funding transfer to the escrow.
            let from_balance = callback_balance(&env, &from);
            let to_balance = callback_balance(&env, &to);
            env.storage()
                .persistent()
                .set(&CallbackTokenKey::Balance(from), &(from_balance - amount));
            env.storage()
                .persistent()
                .set(&CallbackTokenKey::Balance(to), &(to_balance + amount));
        }
    }
}

#[test]
fn rejecting_contract_payee_returns_dedicated_error_without_settling() {
    let env = Env::default();
    env.mock_all_auths();

    let token_id = env.register(CallbackToken, ());
    let token = CallbackTokenClient::new(&env, &token_id);
    let payer = Address::generate(&env);
    token.set_balance(&payer, &1_000);
    let payee_id = env.register(RejectingPayee, ());
    let releaser = Address::generate(&env);
    let contract_id = env.register(EscrowContract, (soroban_sdk::Vec::<Address>::new(&env),));
    token.set_escrow(&contract_id);
    let client = EscrowContractClient::new(&env, &contract_id);
    let escrow_id = client.create_escrow(
        &payer,
        &payee_id,
        &token_id,
        &300,
        &String::from_str(&env, "rejecting-contract-payee"),
        &releaser,
        &None,
        &false,
    );

    let rejected = client.try_release(&escrow_id, &releaser);
    assert_eq!(rejected, Err(Ok(Error::Undeliverable)));
    assert_eq!(client.get_status(&escrow_id), EscrowStatus::Funded);
    assert_eq!(token.balance(&contract_id), 300);
    assert_eq!(token.balance(&payee_id), 0);
}
