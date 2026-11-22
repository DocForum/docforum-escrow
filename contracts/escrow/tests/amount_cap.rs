use docforum_escrow::{Error, EscrowContract, EscrowContractClient, CreateItem};
use soroban_sdk::{testutils::Address as _, token::{StellarAssetClient, TokenClient}, Address, Env, String, Vec};

fn setup(env: &Env, cap: i128) -> (EscrowContractClient<'_>, Address, TokenClient<'_>, Address, Address, Address) {
    env.mock_all_auths();
    let token_id = env.register_stellar_asset_contract_v2(Address::generate(env)).address();
    let token = TokenClient::new(env, &token_id);
    let payer = Address::generate(env);
    let payee = Address::generate(env);
    let releaser = Address::generate(env);
    StellarAssetClient::new(env, &token_id).mint(&payer, &1_000);
    let mut caps = Vec::new(env);
    caps.push_back((token_id.clone(), cap));
    let contract_id = env.register(EscrowContract, (Vec::<Address>::new(env), Address::generate(env), caps));
    (EscrowContractClient::new(env, &contract_id), token_id, token, payer, payee, releaser)
}

#[test]
fn create_accepts_amount_at_cap_and_rejects_over_cap() {
    let env = Env::default();
    let (client, token_id, token, payer, payee, releaser) = setup(&env, 100);
    let condition = String::from_str(&env, "cap");
    let id = client.create_escrow(&payer, &payee, &token_id, &100, &condition, &releaser, &None, &false, &None, &None, &None);
    assert_eq!(id, 0);
    assert_eq!(token.balance(&client.address), 100);
    let result = client.try_create_escrow(&payer, &payee, &token_id, &101, &condition, &releaser, &None, &false, &None, &None, &None);
    assert_eq!(result.unwrap_err(), Ok(Error::AmountCapExceeded));
}

#[test]
fn top_up_checks_the_complete_escrow_amount() {
    let env = Env::default();
    let (client, token_id, token, payer, payee, releaser) = setup(&env, 100);
    let id = client.create_escrow(&payer, &payee, &token_id, &90, &String::from_str(&env, "cap"), &releaser, &None, &false, &None, &None, &None);
    let result = client.try_top_up(&id, &payer, &11);
    assert_eq!(result.unwrap_err(), Ok(Error::AmountCapExceeded));
    assert_eq!(token.balance(&client.address), 90);
}

#[test]
fn batch_creation_checks_each_item() {
    let env = Env::default();
    let (client, token_id, _token, payer, payee, releaser) = setup(&env, 100);
    let mut items = Vec::new(&env);
    items.push_back(CreateItem { payee: payee.clone(), token: token_id.clone(), amount: 100, condition_ref: String::from_str(&env, "a"), releaser: releaser.clone(), refund_after: None });
    items.push_back(CreateItem { payee, token: token_id, amount: 101, condition_ref: String::from_str(&env, "b"), releaser, refund_after: None });
    assert_eq!(client.try_create_escrows(&payer, &items).unwrap_err(), Ok(Error::AmountCapExceeded));
    assert_eq!(client.next_escrow_id(), 0);
}
