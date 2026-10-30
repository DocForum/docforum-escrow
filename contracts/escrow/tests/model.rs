// Property-based state-machine tests for the escrow contract.
//!
//! # Overview
//!
//! This module contains a pure-Rust reference model of the escrow state
//! machine and a proptest state-machine test that runs the model side by side
//! with the contract. Both see the same sequence of operations; after every
//! step the test asserts that the contract's observable state (status, stored
//! amount, token balances) matches the model's prediction, and that the
//! payment invariants hold.
//!
//! The model deliberately covers the *authorization and lifecycle* rules only
//! (who may do what, and when), not fee arithmetic or events — those have
//! dedicated tests. It is small enough to be obviously correct, which is the
//! point: it is the oracle the contract is compared against.
//!
//! # Invariants asserted after every step
//!
//! - I1: tokens only ever move payer -> escrow, escrow -> payee (release) and
//!   escrow -> refund destination (refund); nothing else is credited.
//! - I2: once settled (Released/Refunded) the status never changes again and
//!   every write fails with `NotFunded`.
//! - I3: the escrow's token balance equals the stored amount while `Funded`
//!   and is zero afterwards.
//! - I4: `release` is never gated by `refund_after` (ADR 0004), so a releaser
//!   can always release, even after the deadline.
//! - I5: the timeout refund path opens to anyone exactly at `refund_after`.

use docforum_escrow::{Error, EscrowContract, EscrowContractClient, EscrowStatus};
use proptest::prelude::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    Address, Env, String, Vec,
};

const CREATED_AT: u64 = 1_000;
const DEADLINE: u64 = 1_500;
const INITIAL_BALANCE: i128 = 1_000;

// ---------------------------------------------------------------------------
// Reference model
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    Funded,
    Released,
    Refunded,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Failure {
    Unauthorized,
    NotFunded,
    InvalidAmount,
}

/// The model's prediction for one operation: `Ok`, or the error the contract
/// must return.
type Predicted = Result<(), Failure>;

/// One operation in a generated sequence.
#[derive(Debug, Clone, Copy)]
enum Op {
    /// The payer adds funds. `amount` is 0 only when `zero` is set.
    TopUp { amount: i128 },
    /// A release attempt; `as_releaser` picks the authorized caller.
    Release { as_releaser: bool },
    /// A refund attempt; `as_releaser` picks the authorized caller.
    Refund { as_releaser: bool },
    /// Move the ledger clock forward.
    Advance { seconds: u64 },
}

#[derive(Debug)]
struct Model {
    phase: Phase,
    /// Amount currently escrowed (sum of the original amount and top-ups).
    amount: i128,
    /// Total ever paid in, so payer-side balances can be reconstructed.
    paid_in: i128,
    refund_after: Option<u64>,
    now: u64,
}

impl Model {
    fn new(amount: i128, refund_after: Option<u64>) -> Self {
        Model {
            phase: Phase::Funded,
            amount,
            paid_in: amount,
            refund_after,
            now: CREATED_AT,
        }
    }

    fn timeout_passed(&self) -> bool {
        matches!(self.refund_after, Some(deadline) if self.now >= deadline)
    }

    /// Apply one operation, returning what the contract must do and updating
    /// the model. Never inspects the contract.
    fn apply(&mut self, op: Op) -> Predicted {
        match op {
            Op::Advance { seconds } => {
                self.now = self.now.saturating_add(seconds);
                Ok(())
            }
            Op::TopUp { amount } => {
                if amount <= 0 {
                    return Err(Failure::InvalidAmount);
                }
                if self.phase != Phase::Funded {
                    return Err(Failure::NotFunded);
                }
                self.amount += amount;
                self.paid_in += amount;
                Ok(())
            }
            Op::Release { as_releaser } => {
                // A settled escrow's record is reclaimed (docs/adr/0011), so
                // there is no releaser set left to authorize against: every
                // caller, stranger included, gets NotFunded.
                if self.phase != Phase::Funded {
                    return Err(Failure::NotFunded);
                }
                if !as_releaser {
                    return Err(Failure::Unauthorized);
                }
                self.phase = Phase::Released;
                Ok(())
            }
            Op::Refund { as_releaser } => {
                // Settled first (record reclaimed, docs/adr/0011). Then
                // timeout: after the deadline anyone may refund, and the
                // caller check is skipped entirely.
                if self.phase != Phase::Funded {
                    return Err(Failure::NotFunded);
                }
                if !self.timeout_passed() && !as_releaser {
                    return Err(Failure::Unauthorized);
                }
                self.phase = Phase::Refunded;
                Ok(())
            }
        }
    }

    fn expected_contract_balance(&self) -> i128 {
        match self.phase {
            Phase::Funded => self.amount,
            Phase::Released | Phase::Refunded => 0,
        }
    }

    fn expected_payee_balance(&self) -> i128 {
        match self.phase {
            Phase::Released => self.amount,
            _ => 0,
        }
    }

    fn expected_payer_balance(&self) -> i128 {
        let refunded = if self.phase == Phase::Refunded { self.amount } else { 0 };
        INITIAL_BALANCE - self.paid_in + refunded
    }
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

struct Fixture<'a> {
    client: EscrowContractClient<'a>,
    contract_id: Address,
    token: TokenClient<'a>,
    payer: Address,
    payee: Address,
    releaser: Address,
    stranger: Address,
    escrow_id: u64,
}

/// A test env that does not write a ledger snapshot per randomized case.
///
/// The committed `test_snapshots/` files are a reviewed, deterministic artifact
/// (issue #120); proptest generates hundreds of different ledgers, so those
/// randomized runs must not scatter unstable snapshot files into the tree.
fn quiet_env() -> Env {
    let mut env = Env::default();
    env.set_config(soroban_sdk::testutils::EnvTestConfig {
        capture_snapshot_at_drop: false,
    });
    env
}

fn fixture<'a>(env: &'a Env, amount: i128, refund_after: Option<u64>) -> Fixture<'a> {
    env.ledger().set_timestamp(CREATED_AT);
    env.mock_all_auths();

    let admin = Address::generate(env);
    let sac = env.register_stellar_asset_contract_v2(admin);
    let token = TokenClient::new(env, &sac.address());
    let asset = StellarAssetClient::new(env, &sac.address());

    let payer = Address::generate(env);
    let payee = Address::generate(env);
    let releaser = Address::generate(env);
    let stranger = Address::generate(env);
    asset.mint(&payer, &INITIAL_BALANCE);

    let contract_id = env.register(EscrowContract, (Vec::<Address>::new(env),));
    let client = EscrowContractClient::new(env, &contract_id);
    let escrow_id = client.create_escrow(
        &payer,
        &payee,
        &sac.address(),
        &amount,
        &String::from_str(env, "property-model-condition"),
        &releaser,
        &refund_after,
        &false,
        &None,
        &None,
        &None,
    );

    Fixture {
        client,
        contract_id,
        token,
        payer,
        payee,
        releaser,
        stranger,
        escrow_id,
    }
}

fn status_of(client: &EscrowContractClient, escrow_id: u64) -> Phase {
    match client.get_status(&escrow_id) {
        EscrowStatus::Funded => Phase::Funded,
        EscrowStatus::Released => Phase::Released,
        // Cancelled is unreachable for these fixtures (no acceptance gate)
        // and the model has no state for it.
        EscrowStatus::Refunded | EscrowStatus::Cancelled => Phase::Refunded,
    }
}

/// Run one operation against the contract and coerce the result into the
/// model's vocabulary. Panics on any unexpected error variant so a new error
/// is never silently mapped onto an old one.
fn call(env: &Env, f: &Fixture, op: Op) -> Predicted {
    match op {
        Op::Advance { seconds } => {
            let now = env.ledger().timestamp();
            env.ledger().set_timestamp(now.saturating_add(seconds));
            Ok(())
        }
        Op::TopUp { amount } => match f.client.try_top_up(&f.escrow_id, &f.payer, &amount) {
            Ok(Ok(())) => Ok(()),
            Err(Ok(Error::InvalidAmount)) => Err(Failure::InvalidAmount),
            Err(Ok(Error::NotFunded)) => Err(Failure::NotFunded),
            Err(Ok(Error::Unauthorized)) => Err(Failure::Unauthorized),
            other => panic!("top_up: unexpected result {other:?}"),
        },
        Op::Release { as_releaser } => {
            let caller = if as_releaser { &f.releaser } else { &f.stranger };
            match f.client.try_release(&f.escrow_id, caller) {
                Ok(Ok(())) => Ok(()),
                Err(Ok(Error::NotFunded)) => Err(Failure::NotFunded),
                Err(Ok(Error::Unauthorized)) => Err(Failure::Unauthorized),
                other => panic!("release: unexpected result {other:?}"),
            }
        }
        Op::Refund { as_releaser } => {
            let caller = if as_releaser { &f.releaser } else { &f.stranger };
            match f.client.try_refund(&f.escrow_id, caller) {
                Ok(Ok(())) => Ok(()),
                Err(Ok(Error::NotFunded)) => Err(Failure::NotFunded),
                Err(Ok(Error::Unauthorized)) => Err(Failure::Unauthorized),
                other => panic!("refund: unexpected result {other:?}"),
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/// A small amount so generated sequences cannot overflow the escrow or the
/// payer's balance.
fn arb_amount() -> impl Strategy<Value = i128> {
    prop_oneof![Just(0i128), 1i128..=50i128]
}

fn arb_op() -> impl Strategy<Value = Op> {
    prop_oneof![
        arb_amount().prop_map(|amount| Op::TopUp { amount }),
        any::<bool>().prop_map(|as_releaser| Op::Release { as_releaser }),
        any::<bool>().prop_map(|as_releaser| Op::Refund { as_releaser }),
        (1u64..=200u64).prop_map(|seconds| Op::Advance { seconds }),
    ]
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

proptest! {
    // Keep the default case count low enough for a normal `cargo test`; CI
    // raises PROPTEST_CASES for the nightly job.
    #![proptest_config(ProptestConfig {
        // Honor PROPTEST_CASES so CI can run a bounded pass on every push and a
        // much longer soak on the nightly schedule; 64 keeps `cargo test` quick.
        cases: std::env::var("PROPTEST_CASES")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(64),
        max_shrink_iters: 2048,
        .. ProptestConfig::default()
    })]

    /// The contract must follow the model for every generated operation
    /// sequence, and the payment invariants must hold after every step.
    #[test]
    fn contract_matches_reference_model(
        initial in 1i128..=100i128,
        refund_after in prop_oneof![Just(None), (CREATED_AT + 1..=CREATED_AT + 400).prop_map(Some)],
        ops in prop::collection::vec(arb_op(), 1..30),
    ) {
        let env = quiet_env();
        let f = fixture(&env, initial, refund_after);
        let mut model = Model::new(initial, refund_after);

        for (index, op) in ops.iter().copied().enumerate() {
            let predicted = model.apply(op);
            let actual = call(&env, &f, op);

            prop_assert_eq!(
                actual, predicted,
                "step {}: op {:?} diverged from the model", index, op
            );

            prop_assert_eq!(status_of(&f.client, f.escrow_id), model.phase, "status after step {:?}", op);
            // A funded escrow's stored amount tracks the model; a settled
            // escrow's record is reclaimed (docs/adr/0011), so only the
            // `Status` entry above remains observable.
            if f.client.get_status(&f.escrow_id) == EscrowStatus::Funded {
                prop_assert_eq!(
                    f.client.get_escrow(&f.escrow_id).amount,
                    model.amount,
                    "stored amount after step {:?}", op
                );
            } else {
                prop_assert!(
                    matches!(
                        f.client.try_get_escrow(&f.escrow_id),
                        Err(Ok(Error::NotFound))
                    ),
                    "settled record should be reclaimed after step {:?}", op
                );
            }

            // I3 / I1: balances follow the model exactly.
            prop_assert_eq!(
                f.token.balance(&f.contract_id),
                model.expected_contract_balance(),
                "escrow balance after step {:?}", op
            );
            prop_assert_eq!(
                f.token.balance(&f.payee),
                model.expected_payee_balance(),
                "payee balance after step {:?}", op
            );
            prop_assert_eq!(
                f.token.balance(&f.payer),
                model.expected_payer_balance(),
                "payer balance after step {:?}", op
            );

            // I2: a settled escrow stays settled and refuses every write.
            if model.phase != Phase::Funded {
                prop_assert_eq!(
                    f.client.try_release(&f.escrow_id, &f.releaser),
                    Err(Ok(Error::NotFunded))
                );
                prop_assert_eq!(
                    f.client.try_refund(&f.escrow_id, &f.releaser),
                    Err(Ok(Error::NotFunded))
                );
                prop_assert_eq!(
                    f.client.try_top_up(&f.escrow_id, &f.payer, &1),
                    Err(Ok(Error::NotFunded))
                );
                prop_assert_eq!(status_of(&f.client, f.escrow_id), model.phase);
            }
        }
    }

    /// I4: the releaser can always release, however far past `refund_after`
    /// the clock has moved, and the timeout refund path does not take that
    /// away. This is the ADR 0004 race: whoever lands first wins.
    #[test]
    fn release_always_available_to_releaser(
        amount in 1i128..=100i128,
        overdue_by in 0u64..=10_000u64,
    ) {
        let env = quiet_env();
        let f = fixture(&env, amount, Some(DEADLINE));
        env.ledger().set_timestamp(DEADLINE + overdue_by);

        prop_assert_eq!(
            f.client.try_release(&f.escrow_id, &f.releaser),
            Ok(Ok(()))
        );
        prop_assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Released);
        prop_assert_eq!(f.token.balance(&f.payee), amount);
        prop_assert_eq!(f.token.balance(&f.contract_id), 0);

        // And the settled escrow cannot then be refunded by anyone.
        prop_assert_eq!(
            f.client.try_refund(&f.escrow_id, &f.stranger),
            Err(Ok(Error::NotFunded))
        );
    }

    /// I5: before the deadline a stranger cannot refund; at the deadline and
    /// after, anyone can. The boundary is inclusive.
    #[test]
    fn timeout_refund_opens_exactly_at_deadline(amount in 1i128..=100i128) {
        let env = quiet_env();
        let f = fixture(&env, amount, Some(DEADLINE));

        env.ledger().set_timestamp(DEADLINE - 1);
        prop_assert_eq!(
            f.client.try_refund(&f.escrow_id, &f.stranger),
            Err(Ok(Error::Unauthorized))
        );

        env.ledger().set_timestamp(DEADLINE);
        prop_assert_eq!(
            f.client.try_refund(&f.escrow_id, &f.stranger),
            Ok(Ok(()))
        );
        prop_assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Refunded);
        prop_assert_eq!(f.token.balance(&f.payer), INITIAL_BALANCE);
        prop_assert_eq!(f.token.balance(&f.payee), 0);
    }

    /// I2 again, from the other direction: with no deadline at all, a
    /// stranger's refund stays unauthorized however much time passes.
    #[test]
    fn no_deadline_never_opens_stranger_refund(
        amount in 1i128..=100i128,
        elapsed in 0u64..=1_000_000u64,
    ) {
        let env = quiet_env();
        let f = fixture(&env, amount, None);
        env.ledger().set_timestamp(CREATED_AT + elapsed);

        prop_assert_eq!(
            f.client.try_refund(&f.escrow_id, &f.stranger),
            Err(Ok(Error::Unauthorized))
        );
        prop_assert_eq!(f.client.get_status(&f.escrow_id), EscrowStatus::Funded);
    }
}
