use docforum_escrow::EscrowContractClient;
use docforum_escrow_factory::{Error, EscrowFactory, EscrowFactoryClient};
use soroban_sdk::{
    testutils::Address as _,
    token::{StellarAssetClient, TokenClient},
    Address, Env, String,
};

const ESCROW_WASM: &[u8] =
    include_bytes!("../../target/wasm32v1-none/release/docforum_escrow.wasm");

fn factory<'a>(env: &'a Env) -> EscrowFactoryClient<'a> {
    let wasm_hash = env.deployer().upload_contract_wasm(ESCROW_WASM);
    let id = env.register(EscrowFactory, (&wasm_hash,));
    EscrowFactoryClient::new(env, &id)
}

#[test]
fn deploys_isolated_instances_and_registers_each_integrator() {
    let env = Env::default();
    env.mock_all_auths();

    let factory = factory(&env);
    let first_integrator = Address::generate(&env);
    let second_integrator = Address::generate(&env);
    assert_eq!(factory.get_instance(&first_integrator), None);
    assert_eq!(factory.get_instance(&second_integrator), None);
    let first_expected = factory.predict_instance(&first_integrator);
    let second_expected = factory.predict_instance(&second_integrator);

    let first_instance = factory.create_instance(&first_integrator);
    let second_instance = factory.create_instance(&second_integrator);

    assert_eq!(first_instance, first_expected);
    assert_eq!(second_instance, second_expected);
    assert_ne!(first_instance, second_instance);
    assert_eq!(
        factory.get_instance(&first_integrator),
        Some(first_instance.clone())
    );
    assert_eq!(
        factory.get_instance(&second_integrator),
        Some(second_instance.clone())
    );

    let first_client = EscrowContractClient::new(&env, &first_instance);
    let second_client = EscrowContractClient::new(&env, &second_instance);

    let token_id = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    let token = TokenClient::new(&env, &token_id);
    let asset = StellarAssetClient::new(&env, &token_id);
    let first_payer = Address::generate(&env);
    let second_payer = Address::generate(&env);
    let first_payee = Address::generate(&env);
    let second_payee = Address::generate(&env);
    let first_releaser = Address::generate(&env);
    let second_releaser = Address::generate(&env);
    asset.mint(&first_payer, &100);
    asset.mint(&second_payer, &100);

    first_client.create_escrow(
        &first_payer,
        &first_payee,
        &token_id,
        &30,
        &String::from_str(&env, "first-integrator-escrow"),
        &first_releaser,
        &None,
        &false,
        &None,
        &None,
        &None,
    );
    second_client.create_escrow(
        &second_payer,
        &second_payee,
        &token_id,
        &70,
        &String::from_str(&env, "second-integrator-escrow"),
        &second_releaser,
        &None,
        &false,
        &None,
        &None,
        &None,
    );

    assert_eq!(token.balance(&first_instance), 30);
    assert_eq!(token.balance(&second_instance), 70);
    assert_eq!(
        token.balance(&first_instance) + token.balance(&second_instance),
        100
    );
}

#[test]
fn refuses_a_second_instance_for_the_same_integrator() {
    let env = Env::default();
    env.mock_all_auths();

    let factory = factory(&env);
    let integrator = Address::generate(&env);
    let deployed = factory.create_instance(&integrator);

    assert_eq!(
        factory.try_create_instance(&integrator),
        Err(Ok(Error::AlreadyDeployed))
    );
    assert_eq!(factory.get_instance(&integrator), Some(deployed));
}
