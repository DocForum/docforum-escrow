use docforum_escrow::{EscrowContract, EscrowContractClient, EscrowStatus};
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Events as _},
    token::{StellarAssetClient, TokenClient},
    vec, Address, Env, IntoVal, String, Vec,
};

struct Fixture<'a> {
    client: EscrowContractClient<'a>,
    token: TokenClient<'a>,
    payer: Address,
    payee: Address,
    releaser: Address,
    contract_id: Address,
    id: u64,
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
    asset.mint(&payer, &1_000);
    let contract_id = env.register(
        EscrowContract,
        (Vec::<Address>::new(env), Address::generate(env)),
    );
    let client = EscrowContractClient::new(env, &contract_id);
    let id = client.create_escrow(
        &payer,
        &payee,
        &token_id,
        &300,
        &String::from_str(env, "top-up"),
        &releaser,
        &None,
        &false,
        &None,
    );
    Fixture {
        client,
        token,
        payer,
        payee,
        releaser,
        contract_id,
        id,
    }
}

#[test]
fn top_up_adds_funds_to_the_same_funded_escrow() {
    let env = Env::default();
    let f = setup(&env);
    f.client.top_up(&f.id, &f.payer, &200);
    let data = f.client.get_escrow(&f.id);
    assert_eq!(data.amount, 500);
    assert_eq!(data.status, EscrowStatus::Funded);
    assert_eq!(f.token.balance(&f.payer), 500);
    assert_eq!(f.token.balance(&f.contract_id), 500);
    f.client.release(&f.id, &f.releaser);
    assert_eq!(f.token.balance(&f.payee), 500);
}

/// `top_up` is the only lifecycle event this contract emits today (contract
/// lifecycle events are issue #9). Per issue #120 this test's committed
/// snapshot is the one that shows an event diff when the event changes —
/// note there is deliberately no contract call after `top_up`: the test SDK
/// clears the event buffer at the start of every top-level invocation, so a
/// trailing read/assert-call would empty the snapshot's `events` array.
#[test]
fn top_up_emits_an_event() {
    let env = Env::default();
    let f = setup(&env);

    f.client.top_up(&f.id, &f.payer, &200);

    // Only this contract's events: the token's own `transfer` event is
    // emitted by a different contract in the same invocation.
    assert_eq!(
        env.events().all().filter_by_contract(&f.contract_id),
        vec![
            &env,
            (
                f.contract_id.clone(),
                (symbol_short!("top_up"), f.id).into_val(&env),
                (200i128, 500i128).into_val(&env),
            ),
        ]
    );
}

#[test]
fn top_up_rejects_invalid_payer_amount_overflow_and_settled_state() {
    let env = Env::default();
    let f = setup(&env);
    let stranger = Address::generate(&env);
    assert!(f.client.try_top_up(&f.id, &stranger, &1).is_err());
    assert!(f.client.try_top_up(&f.id, &f.payer, &0).is_err());
    assert!(f.client.try_top_up(&f.id, &f.payer, &i128::MAX).is_err());
    f.client.release(&f.id, &f.releaser);
    assert!(f.client.try_top_up(&f.id, &f.payer, &1).is_err());
}
