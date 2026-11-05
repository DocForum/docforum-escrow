use docforum_escrow::{
    Error, EscrowContract, EscrowContractClient, EscrowDependency, EscrowStatus,
};
use soroban_sdk::{
    testutils::Address as _,
    token::{StellarAssetClient, TokenClient},
    Address, Env, String, Vec,
};

const AMOUNT: i128 = 100;

struct Fixture<'a> {
    client: EscrowContractClient<'a>,
    token: TokenClient<'a>,
    token_id: Address,
    contract_id: Address,
    payer: Address,
    payee: Address,
    releaser: Address,
}

fn setup(env: &Env) -> Fixture<'_> {
    env.mock_all_auths();
    let token_id = env
        .register_stellar_asset_contract_v2(Address::generate(env))
        .address();
    let token = TokenClient::new(env, &token_id);
    let asset = StellarAssetClient::new(env, &token_id);
    let payer = Address::generate(env);
    let payee = Address::generate(env);
    let releaser = Address::generate(env);
    asset.mint(&payer, &2_000);

    let contract_id = env.register(EscrowContract, (Vec::<Address>::new(env),));
    let client = EscrowContractClient::new(env, &contract_id);
    Fixture {
        client,
        token,
        token_id,
        contract_id,
        payer,
        payee,
        releaser,
    }
}

fn create(f: &Fixture<'_>, env: &Env) -> u64 {
    f.client.create_escrow(
        &f.payer,
        &f.payee,
        &f.token_id,
        &AMOUNT,
        &String::from_str(env, "dependency-test"),
        &f.releaser,
        &None,
        &false,
        &None,
    )
}

fn create_dependent(
    f: &Fixture<'_>,
    env: &Env,
    dependency_id: u64,
    required_status: EscrowStatus,
) -> u64 {
    f.client.create_escrow_with_dependency(
        &f.payer,
        &f.payee,
        &f.token_id,
        &AMOUNT,
        &String::from_str(env, "dependent-test"),
        &f.releaser,
        &None,
        &false,
        &None,
        &EscrowDependency {
            escrow_id: dependency_id,
            required_status,
        },
    )
}

#[test]
fn escrow_without_dependency_keeps_existing_release_and_refund_behavior() {
    let env = Env::default();
    let f = setup(&env);
    let release_id = create(&f, &env);
    let refund_id = create(&f, &env);

    assert_eq!(f.client.get_dependency(&release_id), None);
    f.client.release(&release_id, &f.releaser);
    f.client.refund(&refund_id, &f.releaser);

    assert_eq!(f.client.get_status(&release_id), EscrowStatus::Released);
    assert_eq!(f.client.get_status(&refund_id), EscrowStatus::Refunded);
    assert_eq!(f.token.balance(&f.payee), AMOUNT);
    assert_eq!(f.token.balance(&f.payer), 1_900);
    assert_eq!(f.token.balance(&f.contract_id), 0);
}

#[test]
fn dependency_must_be_released_before_dependent_release() {
    let env = Env::default();
    let f = setup(&env);
    let dependency_id = create(&f, &env);
    let dependent_id = create_dependent(&f, &env, dependency_id, EscrowStatus::Released);

    assert_eq!(
        f.client.get_dependency(&dependent_id),
        Some(EscrowDependency {
            escrow_id: dependency_id,
            required_status: EscrowStatus::Released,
        })
    );
    let result = f.client.try_release(&dependent_id, &f.releaser);
    assert_eq!(result, Err(Ok(Error::DependencyUnsatisfied)));
    assert_eq!(f.client.get_status(&dependent_id), EscrowStatus::Funded);
    assert_eq!(f.token.balance(&f.payee), 0);
    assert_eq!(f.token.balance(&f.contract_id), AMOUNT * 2);

    f.client.release(&dependency_id, &f.releaser);
    f.client.release(&dependent_id, &f.releaser);
    assert_eq!(f.client.get_status(&dependent_id), EscrowStatus::Released);
    assert_eq!(f.token.balance(&f.payee), AMOUNT * 2);
}

#[test]
fn refunded_dependency_blocks_release_but_not_dependent_refund() {
    let env = Env::default();
    let f = setup(&env);
    let dependency_id = create(&f, &env);
    let dependent_id = create_dependent(&f, &env, dependency_id, EscrowStatus::Released);

    f.client.refund(&dependency_id, &f.releaser);
    assert_eq!(
        f.client.try_release(&dependent_id, &f.releaser),
        Err(Ok(Error::DependencyUnsatisfied))
    );
    assert_eq!(f.client.get_status(&dependent_id), EscrowStatus::Funded);
    assert_eq!(f.token.balance(&f.payee), 0);

    f.client.refund(&dependent_id, &f.releaser);
    assert_eq!(f.client.get_status(&dependent_id), EscrowStatus::Refunded);
    assert_eq!(f.token.balance(&f.payer), 2_000);
    assert_eq!(f.token.balance(&f.contract_id), 0);
}

#[test]
fn dependency_can_require_a_refunded_terminal_status() {
    let env = Env::default();
    let f = setup(&env);
    let dependency_id = create(&f, &env);
    let dependent_id = create_dependent(&f, &env, dependency_id, EscrowStatus::Refunded);

    assert_eq!(
        f.client.try_release(&dependent_id, &f.releaser),
        Err(Ok(Error::DependencyUnsatisfied))
    );
    f.client.refund(&dependency_id, &f.releaser);
    f.client.release(&dependent_id, &f.releaser);

    assert_eq!(f.client.get_status(&dependent_id), EscrowStatus::Released);
    assert_eq!(f.token.balance(&f.payee), AMOUNT);
    assert_eq!(f.token.balance(&f.payer), 1_900);
}

#[test]
fn dependency_chain_requires_each_predecessor_to_be_released() {
    let env = Env::default();
    let f = setup(&env);
    let first_id = create(&f, &env);
    let second_id = create_dependent(&f, &env, first_id, EscrowStatus::Released);
    let third_id = create_dependent(&f, &env, second_id, EscrowStatus::Released);

    assert_eq!(
        f.client.try_release(&third_id, &f.releaser),
        Err(Ok(Error::DependencyUnsatisfied))
    );
    f.client.release(&first_id, &f.releaser);
    f.client.release(&second_id, &f.releaser);
    f.client.release(&third_id, &f.releaser);
    assert_eq!(f.client.get_status(&third_id), EscrowStatus::Released);
}

#[test]
fn quorum_release_cannot_bypass_an_unsatisfied_dependency() {
    let env = Env::default();
    let f = setup(&env);
    let dependency_id = create(&f, &env);
    let mut releasers = Vec::new(&env);
    releasers.push_back(f.releaser.clone());
    let dependent_id = f.client.create_releasers_dependency(
        &f.payer,
        &f.payee,
        &f.token_id,
        &AMOUNT,
        &String::from_str(&env, "dependent-quorum"),
        &releasers,
        &1,
        &None,
        &false,
        &None,
        &EscrowDependency {
            escrow_id: dependency_id,
            required_status: EscrowStatus::Released,
        },
    );

    assert_eq!(
        f.client
            .try_release_with_approvals(&dependent_id, &releasers),
        Err(Ok(Error::DependencyUnsatisfied))
    );
    assert_eq!(f.client.get_status(&dependent_id), EscrowStatus::Funded);
    assert_eq!(f.token.balance(&f.payee), 0);
    assert_eq!(f.token.balance(&f.contract_id), AMOUNT * 2);
}

#[test]
fn acceptance_gated_escrow_can_also_require_a_dependency() {
    let env = Env::default();
    let f = setup(&env);
    let dependency_id = create(&f, &env);
    let dependent_id = f.client.create_acceptance_dependency(
        &f.payer,
        &f.payee,
        &f.token_id,
        &AMOUNT,
        &String::from_str(&env, "dependent-acceptance"),
        &f.releaser,
        &None,
        &true,
        &None,
        &EscrowDependency {
            escrow_id: dependency_id,
            required_status: EscrowStatus::Released,
        },
    );

    assert_eq!(
        f.client.try_release(&dependent_id, &f.releaser),
        Err(Ok(Error::DependencyUnsatisfied))
    );
    f.client.release(&dependency_id, &f.releaser);
    assert_eq!(
        f.client.try_release(&dependent_id, &f.releaser),
        Err(Ok(Error::AcceptanceRequired))
    );
    f.client.accept(&dependent_id, &f.payee);
    f.client.release(&dependent_id, &f.releaser);
    assert_eq!(f.client.get_status(&dependent_id), EscrowStatus::Released);
}

#[test]
fn creation_rejects_self_forward_and_non_terminal_dependencies() {
    let env = Env::default();
    let f = setup(&env);
    let self_dependency = f.client.try_create_escrow_with_dependency(
        &f.payer,
        &f.payee,
        &f.token_id,
        &AMOUNT,
        &String::from_str(&env, "self"),
        &f.releaser,
        &None,
        &false,
        &None,
        &EscrowDependency {
            escrow_id: 0,
            required_status: EscrowStatus::Released,
        },
    );
    assert_eq!(self_dependency, Err(Ok(Error::InvalidDependency)));

    let existing_id = create(&f, &env);
    let forward_dependency = f.client.try_create_escrow_with_dependency(
        &f.payer,
        &f.payee,
        &f.token_id,
        &AMOUNT,
        &String::from_str(&env, "forward"),
        &f.releaser,
        &None,
        &false,
        &None,
        &EscrowDependency {
            escrow_id: existing_id + 2,
            required_status: EscrowStatus::Released,
        },
    );
    assert_eq!(forward_dependency, Err(Ok(Error::InvalidDependency)));

    let funded_dependency = f.client.try_create_escrow_with_dependency(
        &f.payer,
        &f.payee,
        &f.token_id,
        &AMOUNT,
        &String::from_str(&env, "funded"),
        &f.releaser,
        &None,
        &false,
        &None,
        &EscrowDependency {
            escrow_id: existing_id,
            required_status: EscrowStatus::Funded,
        },
    );
    assert_eq!(funded_dependency, Err(Ok(Error::InvalidDependencyStatus)));
    assert_eq!(f.token.balance(&f.payer), 1_900);
    assert_eq!(f.token.balance(&f.contract_id), AMOUNT);
}

#[test]
fn dependency_does_not_bypass_release_or_refund_authorization() {
    let env = Env::default();
    let f = setup(&env);
    let dependency_id = create(&f, &env);
    let dependent_id = create_dependent(&f, &env, dependency_id, EscrowStatus::Released);
    let stranger = Address::generate(&env);

    assert!(f.client.try_release(&dependent_id, &stranger).is_err());
    assert!(f.client.try_refund(&dependent_id, &stranger).is_err());
    assert_eq!(f.client.get_status(&dependent_id), EscrowStatus::Funded);
    assert_eq!(f.token.balance(&f.contract_id), AMOUNT * 2);
}
