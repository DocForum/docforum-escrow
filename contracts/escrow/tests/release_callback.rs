use docforum_escrow::{Error, EscrowContract, EscrowContractClient, EscrowStatus};
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype,
    testutils::Address as _,
    token::{StellarAssetClient, TokenClient},
    Address, Env, String, Vec,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
enum CallbackError {
    Rejected = 1,
}

#[contracttype]
#[derive(Clone)]
enum CallbackKey {
    Reject,
    Attack,
    Target,
    Releaser,
    Payer,
    Payee,
    Token,
    LastId,
    LastAmount,
}

#[contract]
struct PayeeHook;

#[contractimpl]
impl PayeeHook {
    pub fn reject(env: Env, reject: bool) {
        env.storage().instance().set(&CallbackKey::Reject, &reject);
    }

    pub fn last(env: Env) -> (u64, i128) {
        (
            env.storage()
                .instance()
                .get(&CallbackKey::LastId)
                .unwrap_or(0),
            env.storage()
                .instance()
                .get(&CallbackKey::LastAmount)
                .unwrap_or(0),
        )
    }

    pub fn arm(
        env: Env,
        attack: u32,
        escrow: Address,
        releaser: Address,
        payer: Address,
        payee: Address,
        token: Address,
    ) {
        env.storage().instance().set(&CallbackKey::Attack, &attack);
        env.storage().instance().set(&CallbackKey::Target, &escrow);
        env.storage()
            .instance()
            .set(&CallbackKey::Releaser, &releaser);
        env.storage().instance().set(&CallbackKey::Payer, &payer);
        env.storage().instance().set(&CallbackKey::Payee, &payee);
        env.storage().instance().set(&CallbackKey::Token, &token);
    }

    pub fn on_escrow_released(
        env: Env,
        escrow_id: u64,
        _amount: i128,
    ) -> Result<(), CallbackError> {
        if env
            .storage()
            .instance()
            .get::<_, bool>(&CallbackKey::Reject)
            .unwrap_or(false)
        {
            return Err(CallbackError::Rejected);
        }

        env.storage()
            .instance()
            .set(&CallbackKey::LastId, &escrow_id);
        env.storage()
            .instance()
            .set(&CallbackKey::LastAmount, &_amount);

        let attack = env
            .storage()
            .instance()
            .get::<_, u32>(&CallbackKey::Attack)
            .unwrap_or(0);
        match attack {
            1 | 2 => {
                let target: Address = env.storage().instance().get(&CallbackKey::Target).unwrap();
                let releaser: Address = env
                    .storage()
                    .instance()
                    .get(&CallbackKey::Releaser)
                    .unwrap();
                let escrow = EscrowContractClient::new(&env, &target);
                if attack == 1 {
                    escrow.release(&escrow_id, &releaser);
                } else {
                    escrow.refund(&escrow_id, &releaser);
                }
            }
            3 => {
                let target: Address = env.storage().instance().get(&CallbackKey::Target).unwrap();
                let releaser: Address = env
                    .storage()
                    .instance()
                    .get(&CallbackKey::Releaser)
                    .unwrap();
                let payer: Address = env.storage().instance().get(&CallbackKey::Payer).unwrap();
                let payee: Address = env.storage().instance().get(&CallbackKey::Payee).unwrap();
                let token: Address = env.storage().instance().get(&CallbackKey::Token).unwrap();
                let escrow = EscrowContractClient::new(&env, &target);
                escrow.create_escrow(
                    &payer,
                    &payee,
                    &token,
                    &1,
                    &String::from_str(&env, "callback-reentry"),
                    &releaser,
                    &None,
                    &false,
                    &None,
                    &None,
                    &None,
                );
            }
            _ => {}
        }
        Ok(())
    }
}

struct Fixture<'a> {
    escrow: EscrowContractClient<'a>,
    hook: PayeeHookClient<'a>,
    token: TokenClient<'a>,
    payer: Address,
    releaser: Address,
    id: u64,
    escrow_address: Address,
    hook_address: Address,
    token_address: Address,
}

fn fixture(env: &Env) -> Fixture<'_> {
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(admin);
    let token = TokenClient::new(&env, &token_id.address());
    let asset = StellarAssetClient::new(&env, &token_id.address());
    let payer = Address::generate(&env);
    let releaser = Address::generate(&env);
    asset.mint(&payer, &1_000);

    let hook_id = env.register(PayeeHook, ());
    let hook = PayeeHookClient::new(&env, &hook_id);
    let escrow_id = env.register(
        EscrowContract,
        (Vec::<Address>::new(&env), Address::generate(&env)),
    );
    let escrow = EscrowContractClient::new(&env, &escrow_id);
    let id = escrow.create_escrow(
        &payer,
        &hook_id,
        &token_id.address(),
        &300,
        &String::from_str(&env, "callback-test"),
        &releaser,
        &None,
        &true,
        &None,
        &None,
        &None,
    );

    Fixture {
        escrow,
        hook,
        token,
        payer,
        releaser,
        id,
        escrow_address: escrow_id,
        hook_address: hook_id,
        token_address: token_id.address(),
    }
}

#[test]
fn opted_in_contract_payee_receives_release_callback() {
    let env = Env::default();
    let f = fixture(&env);
    f.escrow.release(&f.id, &f.releaser);
    assert_eq!(f.escrow.get_status(&f.id), EscrowStatus::Released);
    assert_eq!(f.hook.last(), (f.id, 300));
}

#[test]
fn quorum_release_invokes_opted_in_contract_payee() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(admin);
    let token = TokenClient::new(&env, &token_id.address());
    let asset = StellarAssetClient::new(&env, &token_id.address());
    let payer = Address::generate(&env);
    let first = Address::generate(&env);
    let second = Address::generate(&env);
    asset.mint(&payer, &1_000);
    let hook_id = env.register(PayeeHook, ());
    let hook = PayeeHookClient::new(&env, &hook_id);
    let escrow_id = env.register(
        EscrowContract,
        (
            soroban_sdk::Vec::<Address>::new(&env),
            Address::generate(&env),
        ),
    );
    let escrow = EscrowContractClient::new(&env, &escrow_id);
    let id = escrow.create_escrow_with_releasers(
        &payer,
        &hook_id,
        &token_id.address(),
        &300,
        &String::from_str(&env, "quorum-callback-test"),
        &soroban_sdk::vec![&env, first.clone(), second.clone()],
        &2,
        &None,
        &true,
        &None,
    );

    escrow.release_with_approvals(&id, &soroban_sdk::vec![&env, first, second]);

    assert_eq!(escrow.get_status(&id), EscrowStatus::Released);
    assert_eq!(hook.last(), (id, 300));
    assert_eq!(token.balance(&hook_id), 300);
}

#[test]
fn callback_error_reverts_release_but_does_not_block_refund() {
    let env = Env::default();
    let f = fixture(&env);
    f.hook.reject(&true);
    assert_eq!(
        f.escrow.try_release(&f.id, &f.releaser),
        Err(Ok(Error::CallbackFailed))
    );
    assert_eq!(f.escrow.get_status(&f.id), EscrowStatus::Funded);
    assert_eq!(f.token.balance(&f.payer), 700);
    f.escrow.refund(&f.id, &f.releaser);
    assert_eq!(f.escrow.get_status(&f.id), EscrowStatus::Refunded);
    assert_eq!(f.token.balance(&f.payer), 1_000);
}

#[test]
#[should_panic(expected = "Contract re-entry is not allowed")]
fn callback_cannot_reenter_release() {
    let env = Env::default();
    let f = fixture(&env);
    f.hook.arm(
        &1,
        &f.escrow_address,
        &f.releaser,
        &f.payer,
        &f.hook_address,
        &f.token_address,
    );
    f.escrow.release(&f.id, &f.releaser);
}

#[test]
#[should_panic(expected = "Contract re-entry is not allowed")]
fn callback_cannot_reenter_refund() {
    let env = Env::default();
    let f = fixture(&env);
    f.hook.arm(
        &2,
        &f.escrow_address,
        &f.releaser,
        &f.payer,
        &f.hook_address,
        &f.token_address,
    );
    f.escrow.release(&f.id, &f.releaser);
}

#[test]
#[should_panic(expected = "Contract re-entry is not allowed")]
fn callback_cannot_reenter_create_escrow() {
    let env = Env::default();
    let f = fixture(&env);
    f.hook.arm(
        &3,
        &f.escrow_address,
        &f.releaser,
        &f.payer,
        &f.hook_address,
        &f.token_address,
    );
    f.escrow.release(&f.id, &f.releaser);
}
