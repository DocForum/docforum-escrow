// Tests for issue #41: extend an escrow's refund deadline only with
// payer and releaser authorization while the original deadline is active.

use docforum_escrow::{EscrowContract, EscrowContractClient, EscrowStatus};
use soroban_sdk::{
    testutils::{Address as _, Ledger as _, MockAuth, MockAuthInvoke},
    token::StellarAssetClient,
    Address, Env, IntoVal, String, Vec,
};

#[path = "common/auth.rs"]
mod auth;

const CREATED_AT: u64 = 1_000;
const DEADLINE: u64 = 1_100;

struct Fixture<'a> {
    client: EscrowContractClient<'a>,
    escrow_id: u64,
    contract_id: Address,
    payer: Address,
    releaser: Address,
}

fn fund_escrow(env: &Env, refund_after: Option<u64>) -> Fixture<'_> {
    env.ledger().set_timestamp(CREATED_AT);
    let admin = Address::generate(env);
    let token_id = env.register_stellar_asset_contract_v2(admin).address();
    let asset = StellarAssetClient::new(env, &token_id);
    let payer = Address::generate(env);
    let payee = Address::generate(env);
    let releaser = Address::generate(env);
    asset.mint(&payer, &1_000);

    let pause_admin = Address::generate(env);
    let contract_id = env.register(EscrowContract, (Vec::<Address>::new(env), pause_admin));
    let client = EscrowContractClient::new(env, &contract_id);
    let escrow_id = client.create_escrow(
        &payer,
        &payee,
        &token_id,
        &300,
        &String::from_str(env, "issue-41"),
        &releaser,
        &refund_after,
        &false,
        &None,
        &None,
        &None,
    );

    Fixture {
        client,
        escrow_id,
        contract_id,
        payer,
        releaser,
    }
}

#[test]
fn payer_and_releaser_can_extend_deadline_and_get_escrow_returns_latest_value() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund_escrow(&env, Some(DEADLINE));

    f.client
        .extend_refund_after(&f.escrow_id, &(DEADLINE + 100));

    let updated = f.client.get_escrow(&f.escrow_id);
    assert_eq!(updated.status, EscrowStatus::Funded);
    assert_eq!(updated.refund_after, Some(DEADLINE + 100));
}

#[test]
fn extension_fails_when_auth_is_missing() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund_escrow(&env, Some(DEADLINE));

    // Replace the all-auth mock with an empty authorization set.
    env.mock_auths(&[]);
    let result = f
        .client
        .try_extend_refund_after(&f.escrow_id, &(DEADLINE + 100));

    assert!(result.is_err());
    assert_eq!(
        f.client.get_escrow(&f.escrow_id).refund_after,
        Some(DEADLINE)
    );
}

#[test]
fn extension_rejects_an_earlier_or_equal_deadline() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund_escrow(&env, Some(DEADLINE));

    assert!(f
        .client
        .try_extend_refund_after(&f.escrow_id, &DEADLINE)
        .is_err());
    assert!(f
        .client
        .try_extend_refund_after(&f.escrow_id, &(DEADLINE - 1))
        .is_err());
    assert_eq!(
        f.client.get_escrow(&f.escrow_id).refund_after,
        Some(DEADLINE)
    );
}

#[test]
fn extension_rejects_after_the_existing_deadline_passes() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund_escrow(&env, Some(DEADLINE));
    env.ledger().set_timestamp(DEADLINE);

    let result = f
        .client
        .try_extend_refund_after(&f.escrow_id, &(DEADLINE + 100));

    assert!(result.is_err());
    assert_eq!(
        f.client.get_escrow(&f.escrow_id).refund_after,
        Some(DEADLINE)
    );
}

#[test]
fn extension_requires_an_existing_deadline() {
    let env = Env::default();
    env.mock_all_auths();
    let f = fund_escrow(&env, None);

    assert!(f
        .client
        .try_extend_refund_after(&f.escrow_id, &(DEADLINE + 100))
        .is_err());
    assert_eq!(f.client.get_escrow(&f.escrow_id).refund_after, None);
}

// --- exact authorization trees (issue #474) -------------------------------

fn extension_invoke<'a>(env: &Env, f: &'a Fixture<'a>, new_deadline: u64) -> MockAuthInvoke<'a> {
    MockAuthInvoke {
        contract: &f.contract_id,
        fn_name: "extend_refund_after",
        args: (f.escrow_id, new_deadline).into_val(env),
        sub_invokes: &[],
    }
}

#[test]
fn extension_records_the_payers_and_releasers_exact_trees() {
    let env = Env::default();
    env.mock_all_auths(); // fixture funding only
    let f = fund_escrow(&env, Some(DEADLINE));
    let new_deadline = DEADLINE + 100;
    let invoke = extension_invoke(&env, &f, new_deadline);

    env.mock_auths(&[
        MockAuth {
            address: &f.payer,
            invoke: &invoke,
        },
        MockAuth {
            address: &f.releaser,
            invoke: &invoke,
        },
    ]);

    f.client.extend_refund_after(&f.escrow_id, &new_deadline);

    auth::assert_auth_trees(&env, &[(&f.payer, &invoke), (&f.releaser, &invoke)]);
    assert_eq!(
        f.client.get_escrow(&f.escrow_id).refund_after,
        Some(new_deadline)
    );
}

#[test]
fn extension_fails_when_only_the_payer_signs() {
    let env = Env::default();
    env.mock_all_auths(); // fixture funding only
    let f = fund_escrow(&env, Some(DEADLINE));
    let invoke = extension_invoke(&env, &f, DEADLINE + 100);

    env.mock_auths(&[MockAuth {
        address: &f.payer,
        invoke: &invoke,
    }]);

    assert!(matches!(
        f.client
            .try_extend_refund_after(&f.escrow_id, &(DEADLINE + 100)),
        Err(Err(soroban_sdk::InvokeError::Abort))
    ));
    assert_eq!(
        f.client.get_escrow(&f.escrow_id).refund_after,
        Some(DEADLINE)
    );
}

#[test]
fn extension_fails_when_only_the_releaser_signs() {
    let env = Env::default();
    env.mock_all_auths(); // fixture funding only
    let f = fund_escrow(&env, Some(DEADLINE));
    let invoke = extension_invoke(&env, &f, DEADLINE + 100);

    env.mock_auths(&[MockAuth {
        address: &f.releaser,
        invoke: &invoke,
    }]);

    assert!(matches!(
        f.client
            .try_extend_refund_after(&f.escrow_id, &(DEADLINE + 100)),
        Err(Err(soroban_sdk::InvokeError::Abort))
    ));
    assert_eq!(
        f.client.get_escrow(&f.escrow_id).refund_after,
        Some(DEADLINE)
    );
}

#[test]
fn extension_rejects_a_stranger_signing_the_exact_tree() {
    let env = Env::default();
    env.mock_all_auths(); // fixture funding only
    let f = fund_escrow(&env, Some(DEADLINE));
    let stranger = Address::generate(&env);
    let invoke = extension_invoke(&env, &f, DEADLINE + 100);

    env.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &invoke,
    }]);

    assert!(matches!(
        f.client
            .try_extend_refund_after(&f.escrow_id, &(DEADLINE + 100)),
        Err(Err(soroban_sdk::InvokeError::Abort))
    ));
    assert_eq!(
        f.client.get_escrow(&f.escrow_id).refund_after,
        Some(DEADLINE)
    );
}
