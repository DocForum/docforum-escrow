// Batch settlement — issue #29, docs/adr/0012.
//
// What the reviewer checks: per-op auth. A batch can never settle an
// escrow whose releaser is someone else (`another_releasers_escrow_is_never_settled`),
// and every rejected op leaves its escrow exactly as it was.
//
// Every payout assertion checks real token balances, not just status
// (hard rule 2).

use docforum_escrow::{
    Error, EscrowContract, EscrowContractClient, EscrowStatus, SettleAction, MAX_SETTLE_OPS,
};
use soroban_sdk::{
    contract, contracterror, contractimpl,
    testutils::{Address as _, Events as _, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    Address, Env, String, Vec,
};

const CREATED_AT: u64 = 1_000;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
enum HookError {
    Rejected = 1,
}

/// A contract payee whose release callback always fails.
#[contract]
struct RejectingPayee;

#[contractimpl]
impl RejectingPayee {
    pub fn on_escrow_released(_env: Env, _escrow_id: u64, _amount: i128) -> Result<(), HookError> {
        Err(HookError::Rejected)
    }
}

struct Fixture<'a> {
    env: &'a Env,
    client: EscrowContractClient<'a>,
    contract_id: Address,
    token_id: Address,
    token: TokenClient<'a>,
    payer: Address,
    payee: Address,
    releaser: Address,
}

fn fixture(env: &Env) -> Fixture<'_> {
    env.mock_all_auths();
    env.ledger().set_timestamp(CREATED_AT);
    let token_id = env
        .register_stellar_asset_contract_v2(Address::generate(env))
        .address();
    let payer = Address::generate(env);
    StellarAssetClient::new(env, &token_id).mint(&payer, &1_000_000);
    let contract_id = env.register(EscrowContract, (Vec::<Address>::new(env),));
    Fixture {
        env,
        client: EscrowContractClient::new(env, &contract_id),
        contract_id,
        token: TokenClient::new(env, &token_id),
        token_id,
        payer,
        payee: Address::generate(env),
        releaser: Address::generate(env),
    }
}

impl<'a> Fixture<'a> {
    fn cond(&self) -> String {
        String::from_str(self.env, "batch-settle")
    }

    fn create_for(&self, releaser: &Address, payee: &Address, amount: i128) -> u64 {
        self.client.create_escrow(
            &self.payer,
            payee,
            &self.token_id,
            &amount,
            &self.cond(),
            releaser,
            &None,
            &false,
            &None,
        )
    }

    fn create(&self, amount: i128) -> u64 {
        self.create_for(&self.releaser, &self.payee, amount)
    }

    fn ops(&self, items: &[(u64, SettleAction)]) -> Vec<(u64, SettleAction)> {
        let mut ops = Vec::new(self.env);
        for item in items {
            ops.push_back(*item);
        }
        ops
    }

    fn status(&self, id: u64) -> EscrowStatus {
        self.client.get_status(&id)
    }
}

fn ok() -> Result<(), Error> {
    Ok(())
}

#[test]
fn batch_release_pays_every_payee() {
    let env = Env::default();
    let f = fixture(&env);
    let payees = [
        Address::generate(&env),
        Address::generate(&env),
        Address::generate(&env),
    ];
    let ids: [u64; 3] = [
        f.create_for(&f.releaser, &payees[0], 10),
        f.create_for(&f.releaser, &payees[1], 20),
        f.create_for(&f.releaser, &payees[2], 30),
    ];

    let results = f.client.settle_many(
        &f.releaser,
        &f.ops(&[
            (ids[0], SettleAction::Release),
            (ids[1], SettleAction::Release),
            (ids[2], SettleAction::Release),
        ]),
    );

    assert_eq!(results, soroban_sdk::vec![&env, ok(), ok(), ok()]);
    for (i, amount) in [10i128, 20, 30].iter().enumerate() {
        assert_eq!(f.status(ids[i]), EscrowStatus::Released);
        assert_eq!(f.token.balance(&payees[i]), *amount);
    }
    assert_eq!(f.token.balance(&f.contract_id), 0);
}

#[test]
fn batch_refund_returns_funds_to_refund_to() {
    let env = Env::default();
    let f = fixture(&env);
    let sponsor_dest = Address::generate(&env);
    let a = f.create(40);
    let b = f.client.create_escrow(
        &f.payer,
        &f.payee,
        &f.token_id,
        &60,
        &f.cond(),
        &f.releaser,
        &None,
        &false,
        &Some(sponsor_dest.clone()),
    );
    let payer_before = f.token.balance(&f.payer);

    let results = f.client.settle_many(
        &f.releaser,
        &f.ops(&[(a, SettleAction::Refund), (b, SettleAction::Refund)]),
    );

    assert_eq!(results, soroban_sdk::vec![&env, ok(), ok()]);
    assert_eq!(f.status(a), EscrowStatus::Refunded);
    assert_eq!(f.status(b), EscrowStatus::Refunded);
    assert_eq!(f.token.balance(&f.payer), payer_before + 40);
    assert_eq!(f.token.balance(&sponsor_dest), 60);
    assert_eq!(f.token.balance(&f.payee), 0);
}

#[test]
fn mixed_release_and_refund_in_one_batch() {
    let env = Env::default();
    let f = fixture(&env);
    let a = f.create(10);
    let b = f.create(20);
    let payer_before = f.token.balance(&f.payer);

    let results = f.client.settle_many(
        &f.releaser,
        &f.ops(&[(a, SettleAction::Release), (b, SettleAction::Refund)]),
    );

    assert_eq!(results, soroban_sdk::vec![&env, ok(), ok()]);
    assert_eq!(f.status(a), EscrowStatus::Released);
    assert_eq!(f.status(b), EscrowStatus::Refunded);
    assert_eq!(f.token.balance(&f.payee), 10);
    assert_eq!(f.token.balance(&f.payer), payer_before + 20);
}

#[test]
fn another_releasers_escrow_is_never_settled() {
    let env = Env::default();
    let f = fixture(&env);
    let other = Address::generate(&env);
    let mine = f.create(10);
    let theirs_release = f.create_for(&other, &f.payee, 20);
    let theirs_refund = f.create_for(&other, &f.payee, 30);
    let payer_before = f.token.balance(&f.payer);

    let results = f.client.settle_many(
        &f.releaser,
        &f.ops(&[
            (theirs_release, SettleAction::Release),
            (mine, SettleAction::Release),
            (theirs_refund, SettleAction::Refund),
        ]),
    );

    assert_eq!(
        results,
        soroban_sdk::vec![
            &env,
            Err(Error::Unauthorized),
            ok(),
            Err(Error::Unauthorized)
        ]
    );
    assert_eq!(f.status(theirs_release), EscrowStatus::Funded);
    assert_eq!(f.status(theirs_refund), EscrowStatus::Funded);
    assert_eq!(f.status(mine), EscrowStatus::Released);
    assert_eq!(f.token.balance(&f.payee), 10);
    assert_eq!(f.token.balance(&f.payer), payer_before);
    assert_eq!(f.token.balance(&f.contract_id), 50);
}

#[test]
fn same_escrow_twice_second_op_fails_not_funded() {
    let env = Env::default();
    let f = fixture(&env);
    let id = f.create(25);

    let results = f.client.settle_many(
        &f.releaser,
        &f.ops(&[(id, SettleAction::Release), (id, SettleAction::Refund)]),
    );

    assert_eq!(
        results,
        soroban_sdk::vec![&env, ok(), Err(Error::NotFunded)]
    );
    assert_eq!(f.status(id), EscrowStatus::Released);
    assert_eq!(f.token.balance(&f.payee), 25);
    assert_eq!(f.token.balance(&f.contract_id), 0);
}

#[test]
fn per_op_rejections_leave_each_escrow_untouched() {
    let env = Env::default();
    let f = fixture(&env);

    // Already settled.
    let settled = f.create(1);
    f.client.release(&settled, &f.releaser);
    // Quorum escrow (threshold 2): the single-caller path is refused.
    let quorum = f.client.create_escrow_with_releasers(
        &f.payer,
        &f.payee,
        &f.token_id,
        &2,
        &f.cond(),
        &soroban_sdk::vec![&env, f.releaser.clone(), Address::generate(&env)],
        &2,
        &None,
        &false,
        &None,
    );
    // Time-locked release.
    let locked = f.client.create_escrow_release_time(
        &f.payer,
        &f.payee,
        &f.token_id,
        &3,
        &f.cond(),
        &f.releaser,
        &None,
        &false,
        &None,
        &Some(CREATED_AT + 100),
    );
    // Payee acceptance not yet given.
    let unaccepted = f.client.create_escrow_with_acceptance(
        &f.payer,
        &f.payee,
        &f.token_id,
        &4,
        &f.cond(),
        &f.releaser,
        &None,
        &true,
        &None,
    );
    // Pooled, below target.
    let pooled = f.client.create_pooled_escrow(
        &f.payer,
        &f.payee,
        &f.token_id,
        &100,
        &f.cond(),
        &f.releaser,
        &(CREATED_AT + 300),
    );
    f.client.contribute(&pooled, &f.payer, &5);
    let good = f.create(6);
    let contract_before = f.token.balance(&f.contract_id);

    let results = f.client.settle_many(
        &f.releaser,
        &f.ops(&[
            (999, SettleAction::Release),
            (settled, SettleAction::Refund),
            (quorum, SettleAction::Release),
            (quorum, SettleAction::Refund),
            (locked, SettleAction::Release),
            (unaccepted, SettleAction::Release),
            (pooled, SettleAction::Release),
            (pooled, SettleAction::Refund),
            (good, SettleAction::Release),
        ]),
    );

    assert_eq!(
        results,
        soroban_sdk::vec![
            &env,
            Err(Error::NotFound),
            Err(Error::NotFunded),
            Err(Error::ThresholdNotMet),
            Err(Error::ThresholdNotMet),
            Err(Error::ReleaseTooEarly),
            Err(Error::AcceptanceRequired),
            Err(Error::FundingIncomplete),
            Err(Error::NotSupportedForPooled),
            ok(),
        ]
    );
    for id in [quorum, locked, unaccepted, pooled] {
        assert_eq!(f.status(id), EscrowStatus::Funded);
    }
    assert_eq!(f.token.balance(&f.contract_id), contract_before - 6);
}

#[test]
fn timeout_refund_op_opens_to_anyone_only_after_the_deadline() {
    let env = Env::default();
    let f = fixture(&env);
    let stranger = Address::generate(&env);
    let id = f.client.create_escrow(
        &f.payer,
        &f.payee,
        &f.token_id,
        &50,
        &f.cond(),
        &f.releaser,
        &Some(CREATED_AT + 100),
        &false,
        &None,
    );
    let payer_before = f.token.balance(&f.payer);

    let early = f
        .client
        .settle_many(&stranger, &f.ops(&[(id, SettleAction::Refund)]));
    assert_eq!(early, soroban_sdk::vec![&env, Err(Error::Unauthorized)]);
    assert_eq!(f.status(id), EscrowStatus::Funded);

    // A stranger can never release, deadline or not.
    env.ledger().set_timestamp(CREATED_AT + 100);
    let results = f.client.settle_many(
        &stranger,
        &f.ops(&[(id, SettleAction::Release), (id, SettleAction::Refund)]),
    );
    assert_eq!(
        results,
        soroban_sdk::vec![&env, Err(Error::Unauthorized), ok()]
    );
    assert_eq!(f.status(id), EscrowStatus::Refunded);
    assert_eq!(f.token.balance(&f.payer), payer_before + 50);
    assert_eq!(f.token.balance(&stranger), 0);
}

#[test]
fn caller_authorizes_the_batch_exactly_once() {
    let env = Env::default();
    let f = fixture(&env);
    let a = f.create(1);
    let b = f.create(2);
    let ops = f.ops(&[(a, SettleAction::Release), (b, SettleAction::Release)]);

    f.client.settle_many(&f.releaser, &ops);

    let auths = env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, f.releaser);
}

#[test]
fn batch_without_the_callers_signature_is_rejected() {
    let env = Env::default();
    let f = fixture(&env);
    let id = f.create(7);
    env.set_auths(&[]);

    assert!(f
        .client
        .try_settle_many(&f.releaser, &f.ops(&[(id, SettleAction::Release)]))
        .is_err());
    assert_eq!(f.status(id), EscrowStatus::Funded);
    assert_eq!(f.token.balance(&f.contract_id), 7);
}

#[test]
fn empty_batch_returns_no_results() {
    let env = Env::default();
    let f = fixture(&env);
    let results = f.client.settle_many(&f.releaser, &Vec::new(&env));
    assert_eq!(results.len(), 0);
}

#[test]
fn oversized_batch_is_rejected_before_anything_settles() {
    let env = Env::default();
    let f = fixture(&env);
    let id = f.create(1);
    let mut ops = Vec::new(&env);
    for _ in 0..=MAX_SETTLE_OPS {
        ops.push_back((id, SettleAction::Release));
    }
    assert_eq!(
        f.client.try_settle_many(&f.releaser, &ops),
        Err(Ok(Error::BatchTooLarge))
    );
    assert_eq!(f.status(id), EscrowStatus::Funded);
}

#[test]
fn failing_payee_callback_reverts_the_whole_batch() {
    // Funds moved and then a callback failed: that can't be a clean per-op
    // `Err`, so the batch aborts and every earlier op is rolled back too.
    let env = Env::default();
    let f = fixture(&env);
    let hook = env.register(RejectingPayee, ());
    let plain = f.create(10);
    let hooked = f.client.create_escrow(
        &f.payer,
        &hook,
        &f.token_id,
        &20,
        &f.cond(),
        &f.releaser,
        &None,
        &true,
        &None,
    );

    let result = f.client.try_settle_many(
        &f.releaser,
        &f.ops(&[
            (plain, SettleAction::Release),
            (hooked, SettleAction::Release),
        ]),
    );

    assert_eq!(result, Err(Ok(Error::CallbackFailed)));
    assert_eq!(f.status(plain), EscrowStatus::Funded);
    assert_eq!(f.status(hooked), EscrowStatus::Funded);
    assert_eq!(f.token.balance(&f.payee), 0);
    assert_eq!(f.token.balance(&hook), 0);
    assert_eq!(f.token.balance(&f.contract_id), 30);
}

/// The bound is measured (docs/adr/0012): a worst-case batch —
/// `MAX_SETTLE_OPS` releases to distinct payees with a maximum-length
/// `condition_ref` — must fit Mainnet's per-transaction limits. The
/// binding one is contract events + return value (16,384 bytes): each
/// release emits the full escrow state event plus the token's transfer
/// event, so this test sizes the events the batch actually emitted (XDR,
/// as the network meters them) and requires at least 15% headroom.
#[test]
fn max_batch_fits_mainnet_limits() {
    use soroban_sdk::xdr::{Limits, WriteXdr};

    let env = Env::default();
    let f = fixture(&env);
    let long_ref = String::from_str(&env, &"r".repeat(64));
    let mut ops = Vec::new(&env);
    for _ in 0..MAX_SETTLE_OPS {
        let id = f.client.create_escrow(
            &f.payer,
            &Address::generate(&env),
            &f.token_id,
            &1_000,
            &long_ref,
            &f.releaser,
            &None,
            &false,
            &None,
        );
        ops.push_back((id, SettleAction::Release));
    }

    let results = f.client.settle_many(&f.releaser, &ops);
    let events_bytes: usize = env
        .events()
        .all()
        .events()
        .iter()
        .map(|event| event.to_xdr(Limits::none()).unwrap().len())
        .sum();

    assert_eq!(results.len(), MAX_SETTLE_OPS);
    assert!(results.iter().all(|r| r.is_ok()));
    // One `Ok(())` per op in the return value; a generous allowance.
    let return_bytes = 16 * MAX_SETTLE_OPS as usize + 64;
    assert!(
        events_bytes + return_bytes <= 16_384 * 85 / 100,
        "events {events_bytes} + return {return_bytes} bytes"
    );
    // The other Mainnet per-transaction limits (instructions, memory,
    // write entries/bytes) are enforced on the invocation itself by
    // `Env::default()`; the WASM measurement in docs/adr/0012 shows each
    // well under 25% at this size.
}
