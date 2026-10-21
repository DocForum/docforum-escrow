use docforum_escrow::{EscrowContract, EscrowContractClient};
use docforum_releaser_account::{ReleaserAccount, ReleaserAccountClient};
use soroban_sdk::{testutils::Address as _, token, Address, Env, String, Vec};

#[test]
fn custom_account_can_be_configured_as_escrow_releaser() {
    let env = Env::default();
    env.mock_all_auths();

    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token = token::StellarAssetClient::new(&env, &token_id.address());
    let token_client = token::Client::new(&env, &token_id.address());
    token.mint(&payer, &500);

    let escrow_id = env.register(EscrowContract, (Vec::<Address>::new(&env),));
    let escrow = EscrowContractClient::new(&env, &escrow_id);
    let signer_key = soroban_sdk::BytesN::from_array(&env, &[7; 32]);
    let signers: Vec<soroban_sdk::BytesN<32>> = Vec::from_array(&env, [signer_key]);
    let releaser_id = env.register(
        ReleaserAccount,
        (&escrow_id, &signers, &1u32, &3u32, &10u32),
    );
    let releaser = ReleaserAccountClient::new(&env, &releaser_id);

    let id = escrow.create_escrow(
        &payer,
        &payee,
        &token_id.address(),
        &250,
        &String::from_str(&env, "contract account test"),
        &releaser_id,
        &None,
        &false,
        &None,
    );
    escrow.release(&id, &releaser_id);

    assert_eq!(token_client.balance(&payee), 250);
    assert_eq!(releaser.escrow(), escrow_id);
}
