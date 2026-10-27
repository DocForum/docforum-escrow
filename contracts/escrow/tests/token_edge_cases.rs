//! SAC edge-case coverage: each issued asset has an independent balance and authorization state.
use docforum_escrow::{EscrowContract, EscrowContractClient};
use soroban_sdk::{testutils::Address as _, token::{StellarAssetClient, TokenClient}, Address, Env, String, Vec};

#[test]
fn issued_assets_are_isolated_between_escrows() {
 let env=Env::default(); env.mock_all_auths();
 let issuer=Address::generate(&env); let a=env.register_stellar_asset_contract_v2(issuer.clone());
 let b=env.register_stellar_asset_contract_v2(issuer); let payer=Address::generate(&env); let payee=Address::generate(&env); let rel=Address::generate(&env);
 StellarAssetClient::new(&env,&a.address()).mint(&payer,&100); StellarAssetClient::new(&env,&b.address()).mint(&payer,&200);
 let id=env.register(EscrowContract,(Vec::<Address>::new(&env),)); let c=EscrowContractClient::new(&env,&id);
 c.create_escrow(&payer,&payee,&a.address(),&50,&String::from_str(&env,"a"),&rel,&None,&false,&None,&None,&None);
 c.create_escrow(&payer,&payee,&b.address(),&75,&String::from_str(&env,"b"),&rel,&None,&false,&None,&None,&None);
 assert_eq!(TokenClient::new(&env,&a.address()).balance(&id),50); assert_eq!(TokenClient::new(&env,&b.address()).balance(&id),75);
}
