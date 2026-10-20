use docforum_escrow::{EscrowContract, EscrowContractClient, EscrowStatus};
use soroban_sdk::{
    contracttype,
    testutils::Address as _,
    token::{StellarAssetClient, TokenClient},
    Address, Env, String, Vec,
};

// These test-only types intentionally reproduce the contract's storage key
// and value schemas. Contracttype values serialize by enum variant and named
// field keys, not the Rust type's identifier.
#[contracttype]
enum DataKeyFixture {
    Escrow(u64),
    NextId,
}

#[contracttype]
#[derive(Clone)]
struct EscrowDataV1Fixture {
    payer: Address,
    payee: Address,
    token: Address,
    amount: i128,
    condition_ref: String,
    status: EscrowStatus,
    releaser: Address,
}

#[contracttype]
#[derive(Clone)]
struct EscrowDataV2Fixture {
    payer: Address,
    payee: Address,
    token: Address,
    amount: i128,
    condition_ref: String,
    status: EscrowStatus,
    releaser: Address,
    refund_after: Option<u64>,
}

#[contracttype]
enum StoredEscrowDataFixture {
    V1(EscrowDataV1Fixture),
    V2(EscrowDataV2Fixture),
}

struct Fixture<'a> {
    client: EscrowContractClient<'a>,
    contract_id: Address,
    token_id: Address,
    payer: Address,
    payee: Address,
    releaser: Address,
}

fn setup(env: &Env) -> Fixture<'_> {
    env.mock_all_auths();
    let token_id = env
        .register_stellar_asset_contract_v2(Address::generate(env))
        .address();
    let contract_id = env.register(EscrowContract, (Vec::<Address>::new(env),));
    let payer = Address::generate(env);
    let payee = Address::generate(env);
    let releaser = Address::generate(env);
    StellarAssetClient::new(env, &token_id).mint(&contract_id, &300);
    let client = EscrowContractClient::new(env, &contract_id);
    Fixture {
        client,
        contract_id,
        token_id,
        payer,
        payee,
        releaser,
    }
}

fn assert_written_as_v2(env: &Env, f: &Fixture<'_>, expected_status: EscrowStatus) {
    env.as_contract(&f.contract_id, || {
        let stored: StoredEscrowDataFixture = env
            .storage()
            .persistent()
            .get(&DataKeyFixture::Escrow(0))
            .expect("state-changing action writes a tagged layout");
        match stored {
            StoredEscrowDataFixture::V2(v2) => assert_eq!(v2.status, expected_status),
            StoredEscrowDataFixture::V1(_) => panic!("legacy record was not migrated on write"),
        }
    });
}

#[test]
fn legacy_seven_field_map_is_read_and_migrated_on_release() {
    let env = Env::default();
    let f = setup(&env);
    let old = EscrowDataV1Fixture {
        payer: f.payer.clone(),
        payee: f.payee.clone(),
        token: f.token_id.clone(),
        amount: 300,
        condition_ref: String::from_str(&env, "legacy-v1"),
        status: EscrowStatus::Funded,
        releaser: f.releaser.clone(),
    };
    env.as_contract(&f.contract_id, || {
        env.storage()
            .persistent()
            .set(&DataKeyFixture::Escrow(0), &old);
    });

    let decoded = f.client.get_escrow(&0);
    assert_eq!(decoded.payer, f.payer);
    assert_eq!(decoded.amount, 300);
    assert_eq!(decoded.refund_after, None);
    f.client.release(&0, &f.releaser);

    assert_eq!(TokenClient::new(&env, &f.token_id).balance(&f.payee), 300);
    assert_written_as_v2(&env, &f, EscrowStatus::Released);
}

#[test]
fn current_eight_field_map_is_read_and_migrated_on_refund() {
    let env = Env::default();
    let f = setup(&env);
    let current = EscrowDataV2Fixture {
        payer: f.payer.clone(),
        payee: f.payee.clone(),
        token: f.token_id.clone(),
        amount: 300,
        condition_ref: String::from_str(&env, "current-v2"),
        status: EscrowStatus::Funded,
        releaser: f.releaser.clone(),
        refund_after: None,
    };
    env.as_contract(&f.contract_id, || {
        env.storage()
            .persistent()
            .set(&DataKeyFixture::Escrow(0), &current);
    });

    assert_eq!(f.client.get_escrow(&0).refund_after, None);
    f.client.refund(&0, &f.releaser);
    assert_eq!(TokenClient::new(&env, &f.token_id).balance(&f.payer), 300);
    assert_written_as_v2(&env, &f, EscrowStatus::Refunded);
}

#[test]
fn tagged_v1_variant_is_upgraded_to_the_latest_tagged_record_on_write() {
    let env = Env::default();
    let f = setup(&env);
    let old = EscrowDataV1Fixture {
        payer: f.payer.clone(),
        payee: f.payee.clone(),
        token: f.token_id.clone(),
        amount: 300,
        condition_ref: String::from_str(&env, "tagged-v1"),
        status: EscrowStatus::Funded,
        releaser: f.releaser.clone(),
    };
    env.as_contract(&f.contract_id, || {
        env.storage().persistent().set(
            &DataKeyFixture::Escrow(0),
            &StoredEscrowDataFixture::V1(old),
        );
    });

    f.client.release(&0, &f.releaser);
    assert_written_as_v2(&env, &f, EscrowStatus::Released);
}
