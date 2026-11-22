#![no_std]

use docforum_escrow_interface::EscrowClient;
use soroban_sdk::{contract, contractimpl, Address, Env, String};

/// A minimal example of a contract using the published escrow interface.
#[contract]
pub struct EscrowInterfaceExample;

#[contractimpl]
impl EscrowInterfaceExample {
    /// Creates an escrow and immediately releases it through a nested call.
    ///
    /// The caller authorizes the outer invocation. The same address is used
    /// as payer and releaser so the nested escrow calls inherit that auth.
    pub fn create_and_release(
        env: Env,
        escrow: Address,
        caller: Address,
        payee: Address,
        token: Address,
        amount: i128,
        condition_ref: String,
    ) -> u64 {
        caller.require_auth();
        let client = EscrowClient::new(&env, &escrow);
        let escrow_id = client.create_escrow(
            &caller,
            &payee,
            &token,
            &amount,
            &condition_ref,
            &caller,
            &None,
            &false,
            &None,
            &None,
            &None,
        );
        client.release(&escrow_id, &caller);
        escrow_id
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use docforum_escrow::{EscrowContract, EscrowContractClient, EscrowStatus};
    use soroban_sdk::{
        testutils::Address as _, token::StellarAssetClient, Address, Vec,
    };

    #[test]
    fn nested_interface_call_creates_and_releases() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let token = env.register_stellar_asset_contract_v2(admin);
        let token_client = StellarAssetClient::new(&env, &token.address());
        let caller = Address::generate(&env);
        let payee = Address::generate(&env);
        token_client.mint(&caller, &100);

        let escrow = env.register(
            EscrowContract,
            (Vec::<Address>::new(&env), Address::generate(&env)),
        );
        let example = env.register(EscrowInterfaceExample, ());
        let example_client = EscrowInterfaceExampleClient::new(&env, &example);

        let escrow_id = example_client.create_and_release(
            &escrow,
            &caller,
            &payee,
            &token.address(),
            &100,
            &String::from_str(&env, "interface-example"),
        );

        let escrow_client = EscrowContractClient::new(&env, &escrow);
        assert_eq!(escrow_client.get_status(&escrow_id), EscrowStatus::Released);
        assert_eq!(token_client.balance(&payee), 100);
    }
}
