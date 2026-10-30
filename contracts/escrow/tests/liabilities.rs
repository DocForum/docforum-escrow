// Per-token liability accounting and the `solvency(token)` view — issue #39.
//
// The invariant under test: for every token, the contract's on-chain
// liability counter equals the sum of `amount` over every escrow in that
// token whose status is `Funded`. The oracle below reads every escrow back
// through `get_status`/`get_escrow` (ids are contiguous from 0), so it never trusts the
// test's own bookkeeping.
//
// Coverage of every state-changing entry point (reviewer checklist):
//
//   create_escrow                  -> unit + property (Op::Create)
//   create_escrow_release_time     -> unit + property (Op::CreateTimed)
//   create_escrow_with_acceptance  -> unit + property (Op::CreateAcceptance)
//   create_escrow_with_releasers   -> unit + property (Op::CreateQuorum)
//   create_escrows (batch)         -> unit + property (Op::CreateBatch)
//   create_pooled_escrow           -> unit + property (Op::CreatePooled)
//   top_up                         -> unit + property (Op::TopUp)
//   contribute                     -> unit + property (Op::Contribute)
//   accept                         -> property (Op::Accept; moves no value)
//   rotate_releaser                -> property (Op::Rotate; moves no value)
//   release                        -> unit + property (Op::Release)
//   release_with_approvals         -> unit + property (Op::ReleaseQuorum)
//   settle_many                    -> unit + property (Op::SettleMany)
//   refund (releaser and timeout)  -> unit + property (Op::Refund)
//   refund_with_approvals          -> unit + property (Op::RefundQuorum)
//   cancel                         -> unit + property (Op::Cancel)
//   claim_refund                   -> unit + property (Op::ClaimRefund)

use docforum_escrow::{
    CreateItem, EscrowContract, EscrowContractClient, EscrowStatus, SettleAction,
};
use proptest::prelude::*;
use soroban_sdk::{
    testutils::{storage::Persistent as _, Address as _, Ledger as _},
    token::StellarAssetClient,
    Address, Env, String, Symbol, Vec,
};

const CREATED_AT: u64 = 1_000;
const MINTED: i128 = 1_000_000;
const TOKENS: usize = 2;
const CONTRIBUTORS: usize = 3;

struct Fixture<'a> {
    env: &'a Env,
    client: EscrowContractClient<'a>,
    /// Tokens the escrows use.
    tokens: [Address; TOKENS],
    /// A token no escrow ever uses.
    unused: Address,
    payer: Address,
    payee: Address,
    releaser: Address,
    /// 2-of-3 releaser set for quorum escrows.
    quorum: [Address; 3],
    contributors: [Address; CONTRIBUTORS],
}

fn fixture(env: &Env) -> Fixture<'_> {
    env.mock_all_auths();
    env.ledger().set_timestamp(CREATED_AT);

    let payer = Address::generate(env);
    let contributors = [
        Address::generate(env),
        Address::generate(env),
        Address::generate(env),
    ];
    let new_token = |env: &Env| {
        let id = env
            .register_stellar_asset_contract_v2(Address::generate(env))
            .address();
        let asset = StellarAssetClient::new(env, &id);
        asset.mint(&payer, &MINTED);
        for c in contributors.iter() {
            asset.mint(c, &MINTED);
        }
        id
    };
    let tokens = [new_token(env), new_token(env)];
    let unused = new_token(env);

    let contract_id = env.register(EscrowContract, (Vec::<Address>::new(env),));
    Fixture {
        env,
        client: EscrowContractClient::new(env, &contract_id),
        tokens,
        unused,
        payer,
        payee: Address::generate(env),
        releaser: Address::generate(env),
        quorum: [
            Address::generate(env),
            Address::generate(env),
            Address::generate(env),
        ],
        contributors,
    }
}

impl<'a> Fixture<'a> {
    fn cond(&self) -> String {
        String::from_str(self.env, "liability-test")
    }

    fn create(&self, token: usize, amount: i128) -> u64 {
        self.client.create_escrow(
            &self.payer,
            &self.payee,
            &self.tokens[token],
            &amount,
            &self.cond(),
            &self.releaser,
            &None,
            &false,
            &None,
            &None,
            &None,
        )
    }

    fn create_pooled(&self, token: usize, target: i128) -> u64 {
        self.client.create_pooled_escrow(
            &self.payer,
            &self.payee,
            &self.tokens[token],
            &target,
            &self.cond(),
            &self.releaser,
            &(self.env.ledger().timestamp() + 300),
        )
    }

    fn quorum_vec(&self) -> Vec<Address> {
        soroban_sdk::vec![
            self.env,
            self.quorum[0].clone(),
            self.quorum[1].clone(),
            self.quorum[2].clone(),
        ]
    }

    fn approvals(&self) -> Vec<Address> {
        soroban_sdk::vec![self.env, self.quorum[0].clone(), self.quorum[1].clone()]
    }

    fn liabilities(&self, token: usize) -> i128 {
        self.client.solvency(&self.tokens[token]).1
    }

    /// The oracle: sum of `Funded` amounts per token, read from the
    /// contract's own escrow records.
    fn funded_sum(&self, token: usize) -> i128 {
        let mut sum = 0i128;
        let mut id = 0u64;
        // `get_status` answers for every id ever created, settled or not;
        // only funded escrows still have a full record (docs/adr/0013).
        while let Ok(Ok(status)) = self.client.try_get_status(&id) {
            if status == EscrowStatus::Funded {
                let escrow = self.client.get_escrow(&id);
                if escrow.token == self.tokens[token] {
                    sum += escrow.amount;
                }
            }
            id += 1;
        }
        sum
    }

    /// Asserts the issue #39 invariant for every token, plus that
    /// `solvency` reports the real balance (no value enters or leaves the
    /// contract outside an escrow, so balance == liabilities here).
    fn assert_invariant(&self) {
        for t in 0..TOKENS {
            let (balance, liabilities) = self.client.solvency(&self.tokens[t]);
            assert_eq!(liabilities, self.funded_sum(t), "liabilities drifted for token {t}");
            assert!(liabilities >= 0);
            assert_eq!(balance, liabilities, "balance != liabilities for token {t}");
        }
        assert_eq!(self.client.solvency(&self.unused), (0, 0));
    }
}

// ---------------------------------------------------------------------------
// Unit tests: one per value-moving entry point
// ---------------------------------------------------------------------------

#[test]
fn unused_token_reports_zero() {
    let env = Env::default();
    let f = fixture(&env);
    assert_eq!(f.client.solvency(&f.tokens[0]), (0, 0));
    assert_eq!(f.client.solvency(&f.unused), (0, 0));
}

#[test]
fn creation_paths_add_to_liabilities() {
    let env = Env::default();
    let f = fixture(&env);

    f.create(0, 100);
    assert_eq!(f.liabilities(0), 100);

    f.client.create_escrow_release_time(
        &f.payer,
        &f.payee,
        &f.tokens[0],
        &20,
        &f.cond(),
        &f.releaser,
        &None,
        &false,
        &None,
        &Some(CREATED_AT + 10),
        &None,
        &None,
    );
    f.client.create_escrow_with_acceptance(
        &f.payer, &f.payee, &f.tokens[0], &30, &f.cond(), &f.releaser, &None, &true, &None,
    );
    f.client.create_escrow_with_releasers(
        &f.payer,
        &f.payee,
        &f.tokens[0],
        &40,
        &f.cond(),
        &f.quorum_vec(),
        &2,
        &None,
        &false,
        &None,
    );
    assert_eq!(f.liabilities(0), 190);

    // One item per batch: on current `main`, a batch with two or more
    // items calls `payer.require_auth()` once per item in the same frame
    // and fails `Error(Auth, ExistingValue)` — a pre-existing limitation
    // of `create_escrows`/`settle_many`, not something this change touches.
    for (token, amount) in [(0usize, 5i128), (1, 7)] {
        let items = soroban_sdk::vec![
            &env,
            CreateItem {
                payee: f.payee.clone(),
                token: f.tokens[token].clone(),
                amount,
                condition_ref: f.cond(),
                releaser: f.releaser.clone(),
                refund_after: None,
            },
        ];
        f.client.create_escrows(&f.payer, &items);
    }
    assert_eq!(f.liabilities(0), 195);
    assert_eq!(f.liabilities(1), 7);
    f.assert_invariant();
}

#[test]
fn top_up_adds_to_liabilities() {
    let env = Env::default();
    let f = fixture(&env);
    let id = f.create(0, 100);
    f.client.top_up(&id, &f.payer, &25);
    assert_eq!(f.client.solvency(&f.tokens[0]), (125, 125));
}

#[test]
fn release_and_refund_subtract_from_liabilities() {
    let env = Env::default();
    let f = fixture(&env);
    let a = f.create(0, 100);
    let b = f.create(0, 60);
    f.client.release(&a, &f.releaser);
    assert_eq!(f.client.solvency(&f.tokens[0]), (60, 60));
    f.client.refund(&b, &f.releaser);
    assert_eq!(f.client.solvency(&f.tokens[0]), (0, 0));
}

#[test]
fn timeout_refund_subtracts_from_liabilities() {
    let env = Env::default();
    let f = fixture(&env);
    let id = f.client.create_escrow(
        &f.payer,
        &f.payee,
        &f.tokens[0],
        &80,
        &f.cond(),
        &f.releaser,
        &Some(CREATED_AT + 50),
        &false,
        &None,
        &None,
        &None,
    );
    env.ledger().set_timestamp(CREATED_AT + 50);
    let stranger = Address::generate(&env);
    f.client.refund(&id, &stranger);
    assert_eq!(f.client.solvency(&f.tokens[0]), (0, 0));
}

#[test]
fn quorum_settlements_subtract_from_liabilities() {
    let env = Env::default();
    let f = fixture(&env);
    let make = |amount: i128| {
        f.client.create_escrow_with_releasers(
            &f.payer,
            &f.payee,
            &f.tokens[0],
            &amount,
            &f.cond(),
            &f.quorum_vec(),
            &2,
            &None,
            &false,
            &None,
        )
    };
    let a = make(10);
    let b = make(15);
    f.client.release_with_approvals(&a, &f.approvals());
    assert_eq!(f.liabilities(0), 15);
    f.client.refund_with_approvals(&b, &f.approvals());
    assert_eq!(f.liabilities(0), 0);
    f.assert_invariant();
}

#[test]
fn settle_many_subtracts_each_release() {
    let env = Env::default();
    let f = fixture(&env);
    let a = f.create(0, 10);
    let b = f.create(0, 20);
    f.create(1, 30);
    // One id per call; see `creation_paths_add_to_liabilities` for why.
    f.client.settle_many(&f.releaser, &soroban_sdk::vec![&env, (a, SettleAction::Release)]);
    assert_eq!(f.liabilities(0), 20);
    f.client.settle_many(&f.releaser, &soroban_sdk::vec![&env, (b, SettleAction::Release)]);
    assert_eq!(f.liabilities(0), 0);
    assert_eq!(f.liabilities(1), 30);
    f.assert_invariant();
}

#[test]
fn cancel_subtracts_from_liabilities() {
    let env = Env::default();
    let f = fixture(&env);
    let id = f.client.create_escrow_with_acceptance(
        &f.payer, &f.payee, &f.tokens[0], &45, &f.cond(), &f.releaser, &None, &true, &None,
    );
    assert_eq!(f.liabilities(0), 45);
    f.client.cancel(&id, &f.payer);
    assert_eq!(f.client.solvency(&f.tokens[0]), (0, 0));
}

#[test]
fn pooled_contributions_and_release_track_liabilities() {
    let env = Env::default();
    let f = fixture(&env);
    let id = f.create_pooled(0, 100);
    assert_eq!(f.liabilities(0), 0);
    f.client.contribute(&id, &f.contributors[0], &60);
    f.client.contribute(&id, &f.contributors[1], &40);
    assert_eq!(f.client.solvency(&f.tokens[0]), (100, 100));
    f.client.release(&id, &f.releaser);
    assert_eq!(f.client.solvency(&f.tokens[0]), (0, 0));
}

#[test]
fn pooled_claim_refund_subtracts_each_claim() {
    let env = Env::default();
    let f = fixture(&env);
    let id = f.create_pooled(0, 100);
    f.client.contribute(&id, &f.contributors[0], &30);
    f.client.contribute(&id, &f.contributors[1], &20);
    env.ledger().set_timestamp(CREATED_AT + 300);
    f.client.claim_refund(&id, &f.contributors[0]);
    assert_eq!(f.client.solvency(&f.tokens[0]), (20, 20));
    f.client.claim_refund(&id, &f.contributors[1]);
    assert_eq!(f.client.solvency(&f.tokens[0]), (0, 0));
    f.assert_invariant();
}

#[test]
fn liabilities_are_kept_per_token() {
    let env = Env::default();
    let f = fixture(&env);
    let a = f.create(0, 100);
    f.create(1, 7);
    f.client.release(&a, &f.releaser);
    assert_eq!(f.liabilities(0), 0);
    assert_eq!(f.liabilities(1), 7);
    f.assert_invariant();
}

#[test]
fn failed_operations_leave_liabilities_unchanged() {
    let env = Env::default();
    let f = fixture(&env);
    let id = f.create(0, 100);
    let stranger = Address::generate(&env);
    assert!(f.client.try_release(&id, &stranger).is_err());
    assert!(f.client.try_top_up(&id, &f.payer, &0).is_err());
    f.client.release(&id, &f.releaser);
    assert!(f.client.try_refund(&id, &f.releaser).is_err());
    assert_eq!(f.client.solvency(&f.tokens[0]), (0, 0));
}

#[test]
fn liability_entry_ttl_is_extended_on_write() {
    // Issue #10 consistency: every write re-extends the counter's TTL to
    // LIABILITY_TTL_EXTEND_TO (capped at the network maximum), so monitors
    // never find it archived while escrows in that token are live.
    // `DataKey::Liability(token)` is private; a `#[contracttype]` tuple
    // variant encodes as the vector `[Symbol("Liability"), token]`, which
    // is what this key reproduces.
    let env = Env::default();
    let f = fixture(&env);
    f.create(0, 100);
    let key = (Symbol::new(&env, "Liability"), f.tokens[0].clone());
    let (ttl, max_ttl) = env.as_contract(&f.client.address, || {
        (env.storage().persistent().get_ttl(&key), env.storage().max_ttl())
    });
    let expected = docforum_escrow::LIABILITY_TTL_EXTEND_TO.min(max_ttl);
    assert_eq!(ttl, expected);

    // Still readable once the default TTL of an unextended entry is long gone.
    env.ledger().with_mut(|l| l.sequence_number += expected - 1);
    assert_eq!(f.liabilities(0), 100);
}

// ---------------------------------------------------------------------------
// Property test: any sequence of operations
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy)]
enum Op {
    Create { token: usize, amount: i128, timeout: bool },
    CreateTimed { token: usize, amount: i128 },
    CreateAcceptance { token: usize, amount: i128 },
    CreateQuorum { token: usize, amount: i128 },
    CreateBatch { token: usize, amount: i128 },
    CreatePooled { token: usize, target: i128 },
    TopUp { pick: usize, amount: i128 },
    Contribute { pick: usize, who: usize, amount: i128 },
    Accept { pick: usize },
    Rotate { pick: usize },
    Release { pick: usize },
    ReleaseQuorum { pick: usize },
    SettleMany { pick: usize },
    Refund { pick: usize, stranger: bool },
    RefundQuorum { pick: usize },
    Cancel { pick: usize },
    ClaimRefund { pick: usize, who: usize },
    Advance { seconds: u64 },
}

/// A test env that writes no snapshot per randomized case (issue #120).
fn quiet_env() -> Env {
    let mut env = Env::default();
    env.set_config(soroban_sdk::testutils::EnvTestConfig {
        capture_snapshot_at_drop: false,
    });
    env
}

fn arb_token() -> impl Strategy<Value = usize> {
    0..TOKENS
}

/// Includes 0 and negatives so invalid amounts are exercised too.
fn arb_amount() -> impl Strategy<Value = i128> {
    prop_oneof![1 => -5i128..=0i128, 6 => 1i128..=200i128]
}

fn arb_op() -> impl Strategy<Value = Op> {
    let pick = 0usize..64;
    prop_oneof![
        (arb_token(), arb_amount(), any::<bool>())
            .prop_map(|(token, amount, timeout)| Op::Create { token, amount, timeout }),
        (arb_token(), arb_amount()).prop_map(|(token, amount)| Op::CreateTimed { token, amount }),
        (arb_token(), arb_amount())
            .prop_map(|(token, amount)| Op::CreateAcceptance { token, amount }),
        (arb_token(), arb_amount()).prop_map(|(token, amount)| Op::CreateQuorum { token, amount }),
        (arb_token(), arb_amount()).prop_map(|(token, amount)| Op::CreateBatch { token, amount }),
        (arb_token(), arb_amount()).prop_map(|(token, target)| Op::CreatePooled { token, target }),
        (pick.clone(), arb_amount()).prop_map(|(pick, amount)| Op::TopUp { pick, amount }),
        (pick.clone(), 0..CONTRIBUTORS, arb_amount())
            .prop_map(|(pick, who, amount)| Op::Contribute { pick, who, amount }),
        pick.clone().prop_map(|pick| Op::Accept { pick }),
        pick.clone().prop_map(|pick| Op::Rotate { pick }),
        pick.clone().prop_map(|pick| Op::Release { pick }),
        pick.clone().prop_map(|pick| Op::ReleaseQuorum { pick }),
        pick.clone().prop_map(|pick| Op::SettleMany { pick }),
        (pick.clone(), any::<bool>()).prop_map(|(pick, stranger)| Op::Refund { pick, stranger }),
        pick.clone().prop_map(|pick| Op::RefundQuorum { pick }),
        pick.clone().prop_map(|pick| Op::Cancel { pick }),
        (pick, 0..CONTRIBUTORS).prop_map(|(pick, who)| Op::ClaimRefund { pick, who }),
        (1u64..=200u64).prop_map(|seconds| Op::Advance { seconds }),
    ]
}

/// Maps `pick` onto an existing escrow id (ids are contiguous from 0);
/// `None` before any escrow exists.
fn existing_id(f: &Fixture, pick: usize) -> Option<u64> {
    let mut count = 0u64;
    while let Ok(Ok(_)) = f.client.try_get_status(&count) {
        count += 1;
    }
    (count > 0).then(|| pick as u64 % count)
}

/// Runs one operation. Its outcome doesn't matter: a rejected call must
/// leave the counter untouched just as a successful one must move it.
fn apply(f: &Fixture, op: Op) {
    let env = f.env;
    let now = env.ledger().timestamp();
    match op {
        Op::Create { token, amount, timeout } => {
            let refund_after = timeout.then_some(now + 100);
            let _ = f.client.try_create_escrow(
                &f.payer,
                &f.payee,
                &f.tokens[token],
                &amount,
                &f.cond(),
                &f.releaser,
                &refund_after,
                &false,
                &None,
                &None,
                &None,
            );
        }
        Op::CreateTimed { token, amount } => {
            let _ = f.client.try_create_escrow_release_time(
                &f.payer,
                &f.payee,
                &f.tokens[token],
                &amount,
                &f.cond(),
                &f.releaser,
                &None,
                &false,
                &None,
                &Some(now + 50),
                &None,
                &None,
            );
        }
        Op::CreateAcceptance { token, amount } => {
            let _ = f.client.try_create_escrow_with_acceptance(
                &f.payer,
                &f.payee,
                &f.tokens[token],
                &amount,
                &f.cond(),
                &f.releaser,
                &None,
                &true,
                &None,
            );
        }
        Op::CreateQuorum { token, amount } => {
            let _ = f.client.try_create_escrow_with_releasers(
                &f.payer,
                &f.payee,
                &f.tokens[token],
                &amount,
                &f.cond(),
                &f.quorum_vec(),
                &2,
                &None,
                &false,
                &None,
            );
        }
        Op::CreateBatch { token, amount } => {
            let item = CreateItem {
                payee: f.payee.clone(),
                token: f.tokens[token].clone(),
                amount,
                condition_ref: f.cond(),
                releaser: f.releaser.clone(),
                refund_after: None,
            };
            let _ = f.client.try_create_escrows(&f.payer, &soroban_sdk::vec![env, item]);
        }
        Op::CreatePooled { token, target } => {
            let _ = f.client.try_create_pooled_escrow(
                &f.payer,
                &f.payee,
                &f.tokens[token],
                &target,
                &f.cond(),
                &f.releaser,
                &(now + 300),
            );
        }
        Op::TopUp { pick, amount } => {
            if let Some(id) = existing_id(f, pick) {
                let _ = f.client.try_top_up(&id, &f.payer, &amount);
            }
        }
        Op::Contribute { pick, who, amount } => {
            if let Some(id) = existing_id(f, pick) {
                let _ = f.client.try_contribute(&id, &f.contributors[who], &amount);
            }
        }
        Op::Accept { pick } => {
            if let Some(id) = existing_id(f, pick) {
                let _ = f.client.try_accept(&id, &f.payee);
            }
        }
        Op::Rotate { pick } => {
            if let Some(id) = existing_id(f, pick) {
                let new_releaser = Address::generate(env);
                let _ = f.client.try_rotate_releaser(&id, &f.releaser, &new_releaser);
            }
        }
        Op::Release { pick } => {
            if let Some(id) = existing_id(f, pick) {
                let _ = f.client.try_release(&id, &f.releaser);
            }
        }
        Op::ReleaseQuorum { pick } => {
            if let Some(id) = existing_id(f, pick) {
                let _ = f.client.try_release_with_approvals(&id, &f.approvals());
            }
        }
        Op::SettleMany { pick } => {
            if let Some(id) = existing_id(f, pick) {
                let _ = f.client.try_settle_many(&f.releaser, &soroban_sdk::vec![env, (id, SettleAction::Release)]);
            }
        }
        Op::Refund { pick, stranger } => {
            if let Some(id) = existing_id(f, pick) {
                let caller = if stranger { Address::generate(env) } else { f.releaser.clone() };
                let _ = f.client.try_refund(&id, &caller);
            }
        }
        Op::RefundQuorum { pick } => {
            if let Some(id) = existing_id(f, pick) {
                let _ = f.client.try_refund_with_approvals(&id, &f.approvals());
            }
        }
        Op::Cancel { pick } => {
            if let Some(id) = existing_id(f, pick) {
                let _ = f.client.try_cancel(&id, &f.payer);
            }
        }
        Op::ClaimRefund { pick, who } => {
            if let Some(id) = existing_id(f, pick) {
                let _ = f.client.try_claim_refund(&id, &f.contributors[who]);
            }
        }
        Op::Advance { seconds } => env.ledger().set_timestamp(now + seconds),
    }
}

proptest! {
    #![proptest_config(ProptestConfig {
        // Same knob as tests/model.rs: CI can raise PROPTEST_CASES.
        cases: std::env::var("PROPTEST_CASES")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(48),
        max_shrink_iters: 1024,
        .. ProptestConfig::default()
    })]

    /// After every step of any operation sequence, `liabilities[token]`
    /// equals the sum of `Funded` amounts per token, and the contract's
    /// balance equals it.
    #[test]
    fn liabilities_equal_sum_of_funded_amounts(ops in prop::collection::vec(arb_op(), 1..40)) {
        let env = quiet_env();
        let f = fixture(&env);
        f.assert_invariant();
        for op in ops {
            apply(&f, op);
            f.assert_invariant();
        }
    }
}
