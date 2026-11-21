#![no_main]
//! Quorum settlement and `settle_many` (issue #308).
//!
//! `lifecycle` drives one single-releaser escrow. This target drives the
//! input-shaped paths it never reaches: arbitrary M-of-N releaser sets and
//! thresholds at creation, arbitrary approver lists (duplicates,
//! non-members, short lists) on `release_with_approvals` /
//! `refund_with_approvals`, and arbitrary `settle_many` op vectors
//! (repeats, unknown ids, lengths past `MAX_SETTLE_OPS`).
//!
//! After every step it asserts, against real token balances:
//! - fund conservation: contract + every payee + payer always equals the
//!   minted total, and the contract holds exactly the sum of funded escrows;
//! - at most one payout per escrow: each payee holds 0 or its escrow's full
//!   amount, never both a release and a refund for one escrow;
//! - an `Err` touches nothing: a rejected approval call or `settle_many` op
//!   leaves its escrow's status and every balance as they were.
//!
//! Each call's `Ok`/`Err` is also checked against a small model of the
//! documented rules (docs/adr/0007, docs/adr/0012), so a check that wrongly
//! passes or wrongly rejects is a crash, not just a lost payout.

use docforum_escrow::{
    Error, EscrowContract, EscrowContractClient, EscrowStatus, SettleAction, MAX_SETTLE_OPS,
};
use libfuzzer_sys::fuzz_target;
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    Address, Env, String, Vec,
};

const START_BALANCE: i128 = 1_000_000;
/// Distinct candidate releasers; one more than `MAX_RELEASERS` (10) so an
/// oversized set is reachable.
const POOL: usize = 11;
const MAX_ESCROWS: usize = 4;
const MAX_STEPS: usize = 48;
const START_TIME: u64 = 1_000;

/// Reads input bytes; returns 0 once they run out so every input is valid.
struct Bytes<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Bytes<'a> {
    fn next(&mut self) -> u8 {
        let b = self.data.get(self.pos).copied().unwrap_or(0);
        self.pos += 1;
        b
    }
    fn done(&self) -> bool {
        self.pos >= self.data.len()
    }
}

/// The model's view of one escrow.
#[derive(Clone)]
struct Model {
    id: u64,
    amount: i128,
    payee: usize,
    /// Indices into the address pool.
    releasers: std::vec::Vec<usize>,
    threshold: u32,
    deadline: Option<u64>,
    status: EscrowStatus,
}

impl Model {
    fn funded(&self) -> bool {
        self.status == EscrowStatus::Funded
    }
    /// `check_approvals` (docs/adr/0007): enough entries, all members, no
    /// repeats. Ordered as the contract checks them.
    fn approvals_ok(&self, approvers: &[usize]) -> bool {
        if (approvers.len() as u32) < self.threshold {
            return false;
        }
        let mut seen = std::vec::Vec::new();
        for a in approvers {
            if !self.releasers.contains(a) || seen.contains(a) {
                return false;
            }
            seen.push(*a);
        }
        true
    }
    /// `check_single_caller`: a member of a threshold-1 set.
    fn single_ok(&self, caller: usize) -> bool {
        self.threshold == 1 && self.releasers.contains(&caller)
    }
}

/// Whether `check_releaser_set` accepts a creation request.
fn set_ok(releasers: &[usize], threshold: u32) -> bool {
    if releasers.len() > 10 || threshold == 0 || threshold as usize > releasers.len() {
        return false;
    }
    let mut seen = std::vec::Vec::new();
    for r in releasers {
        if seen.contains(r) {
            return false;
        }
        seen.push(*r);
    }
    true
}

struct World<'a> {
    env: &'a Env,
    client: EscrowContractClient<'a>,
    token: TokenClient<'a>,
    contract: Address,
    payer: Address,
    payees: std::vec::Vec<Address>,
    /// Releaser candidates, then one outsider at index `POOL`.
    pool: std::vec::Vec<Address>,
}

impl World<'_> {
    fn addrs(&self, idx: &[usize]) -> Vec<Address> {
        let mut v = Vec::new(self.env);
        for i in idx {
            v.push_back(self.pool[*i].clone());
        }
        v
    }

    /// The conservation and single-payout invariants, from real balances.
    fn check(&self, escrows: &[Model]) {
        let mut funded = 0i128;
        let mut refunded = 0i128;
        let mut locked = 0i128;
        for e in escrows {
            locked += e.amount;
            let actual = self.client.get_status(&e.id);
            assert_eq!(actual, e.status, "escrow {} status", e.id);
            let paid = self.token.balance(&self.payees[e.payee]);
            match e.status {
                EscrowStatus::Funded => {
                    funded += e.amount;
                    assert_eq!(paid, 0, "funded escrow {} paid out", e.id);
                    assert_eq!(self.client.get_escrow(&e.id).amount, e.amount);
                }
                EscrowStatus::Released => {
                    assert_eq!(paid, e.amount, "release paid escrow {} exactly once", e.id);
                }
                EscrowStatus::Refunded => {
                    assert_eq!(paid, 0, "refunded escrow {} also paid its payee", e.id);
                    refunded += e.amount;
                }
                EscrowStatus::Cancelled => panic!("no path here cancels"),
            }
        }
        let payer = self.token.balance(&self.payer);
        let contract = self.token.balance(&self.contract);
        let payees: i128 = self.payees.iter().map(|p| self.token.balance(p)).sum();
        assert_eq!(
            contract, funded,
            "contract holds exactly the funded escrows"
        );
        assert_eq!(payer, START_BALANCE - locked + refunded, "payer balance");
        assert_eq!(payer + contract + payees, START_BALANCE, "funds conserved");
        for r in &self.pool {
            assert_eq!(self.token.balance(r), 0, "a releaser or outsider was paid");
        }
    }
}

fn run(data: &[u8]) {
    if data.len() < 2 {
        return;
    }
    let mut input = Bytes { data, pos: 0 };

    let mut env = Env::default();
    env.set_config(soroban_sdk::testutils::EnvTestConfig {
        capture_snapshot_at_drop: false,
    });
    env.mock_all_auths();
    env.ledger().set_timestamp(START_TIME);

    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin);
    let token_id = sac.address();
    let payer = Address::generate(&env);
    StellarAssetClient::new(&env, &token_id).mint(&payer, &START_BALANCE);
    let contract = env.register(
        EscrowContract,
        (Vec::<Address>::new(&env), Address::generate(&env)),
    );
    let world = World {
        env: &env,
        client: EscrowContractClient::new(&env, &contract),
        token: TokenClient::new(&env, &token_id),
        contract: contract.clone(),
        payer: payer.clone(),
        payees: (0..MAX_ESCROWS).map(|_| Address::generate(&env)).collect(),
        pool: (0..=POOL).map(|_| Address::generate(&env)).collect(),
    };

    // ── Creation: arbitrary releaser sets and thresholds. ──
    let mut escrows: std::vec::Vec<Model> = std::vec::Vec::new();
    let n_create = 1 + usize::from(input.next()) % MAX_ESCROWS;
    for slot in 0..n_create {
        // Set size 0..=11 (one past the cap); members drawn from the pool,
        // so repeats (DuplicateReleaser) come from the input.
        let size = usize::from(input.next()) % (POOL + 1);
        let releasers: std::vec::Vec<usize> = (0..size)
            .map(|_| usize::from(input.next()) % POOL)
            .collect();
        let threshold = u32::from(input.next()) % (size as u32 + 2);
        let amount = i128::from(input.next() % 100) + 1;
        let deadline_byte = input.next();
        let deadline = (deadline_byte & 1 == 1).then(|| START_TIME + u64::from(deadline_byte % 64));

        let before = world.token.balance(&payer);
        let result = world.client.try_create_escrow_with_releasers(
            &payer,
            &world.payees[slot],
            &token_id,
            &amount,
            &String::from_str(&env, "fuzz-settlement"),
            &world.addrs(&releasers),
            &threshold,
            &deadline,
            &false,
            &None,
        );
        if set_ok(&releasers, threshold) {
            let id = result
                .unwrap_or_else(|e| panic!("valid set {releasers:?}/{threshold} rejected: {e:?}"))
                .unwrap();
            escrows.push(Model {
                id,
                amount,
                payee: slot,
                releasers,
                threshold,
                deadline,
                status: EscrowStatus::Funded,
            });
        } else {
            assert!(
                matches!(
                    result,
                    Err(Ok(Error::TooManyReleasers
                        | Error::InvalidThreshold
                        | Error::DuplicateReleaser))
                ),
                "invalid set {releasers:?}/{threshold} gave {result:?}"
            );
            assert_eq!(
                world.token.balance(&payer),
                before,
                "rejected create moved funds"
            );
        }
        world.check(&escrows);
    }
    if escrows.is_empty() {
        return;
    }
    // An id no escrow has: settle_many must reject it per-op.
    let unknown_id = escrows.iter().map(|e| e.id).max().unwrap() + 1;

    // Picks an escrow index, or `None` for the unknown id.
    let pick = |b: u8, len: usize| -> Option<usize> {
        let i = usize::from(b) % (len + 1);
        (i < len).then_some(i)
    };
    // An approver or caller: a pool member or the outsider.
    let who = |b: u8| usize::from(b) % (POOL + 1);

    let mut now = START_TIME;
    let mut steps = 0;
    while !input.done() && steps < MAX_STEPS {
        steps += 1;
        match input.next() % 4 {
            0 => {
                now += u64::from(input.next() % 40);
                env.ledger().set_timestamp(now);
            }
            op @ (1 | 2) => {
                // release_with_approvals / refund_with_approvals with an
                // arbitrary approver list: short, repeated, outsiders.
                let Some(i) = pick(input.next(), escrows.len()) else {
                    continue;
                };
                let n = usize::from(input.next()) % 8;
                let approvers: std::vec::Vec<usize> = (0..n).map(|_| who(input.next())).collect();
                let e = &escrows[i];
                let expect_ok = e.funded() && e.approvals_ok(&approvers);
                let snapshot = escrows.clone();
                let result = if op == 1 {
                    world
                        .client
                        .try_release_with_approvals(&e.id, &world.addrs(&approvers))
                } else {
                    world
                        .client
                        .try_refund_with_approvals(&e.id, &world.addrs(&approvers))
                };
                if expect_ok {
                    assert_eq!(result, Ok(Ok(())), "approvals {approvers:?} on {}", e.id);
                    escrows[i].status = if op == 1 {
                        EscrowStatus::Released
                    } else {
                        EscrowStatus::Refunded
                    };
                } else {
                    assert!(
                        result.is_err(),
                        "approvals {approvers:?} wrongly settled {}",
                        e.id
                    );
                    // A settled escrow always answers NotFunded, whatever the list.
                    if !e.funded() {
                        assert_eq!(result, Err(Ok(Error::NotFunded)));
                    }
                    // Err touches nothing.
                    world.check(&snapshot);
                }
            }
            _ => {
                // settle_many with an arbitrary op vector: repeats, unknown
                // ids, mixed actions, and lengths past MAX_SETTLE_OPS.
                let caller = who(input.next());
                let len = usize::from(input.next()) % (MAX_SETTLE_OPS as usize + 4);
                let mut ops = Vec::new(&env);
                let mut picked = std::vec::Vec::new();
                for _ in 0..len {
                    let b = input.next();
                    let target = pick(b >> 1, escrows.len());
                    let action = if b & 1 == 0 {
                        SettleAction::Release
                    } else {
                        SettleAction::Refund
                    };
                    let id = target.map(|t| escrows[t].id).unwrap_or(unknown_id);
                    ops.push_back((id, action));
                    picked.push((target, action));
                }
                let snapshot = escrows.clone();
                let result = world.client.try_settle_many(&world.pool[caller], &ops);

                if len > MAX_SETTLE_OPS as usize {
                    assert_eq!(result, Err(Ok(Error::BatchTooLarge)));
                    world.check(&snapshot);
                    continue;
                }
                let results = result
                    .unwrap_or_else(|e| panic!("settle_many of {len} ops failed: {e:?}"))
                    .unwrap();
                assert_eq!(results.len() as usize, len, "one result per op");

                for (k, (target, action)) in picked.iter().enumerate() {
                    let got = results.get(k as u32).unwrap();
                    let Some(t) = *target else {
                        assert!(got.is_err(), "unknown id settled");
                        continue;
                    };
                    let e = &escrows[t];
                    let timeout = e.deadline.is_some_and(|d| now >= d);
                    let expect_ok = e.funded()
                        && match action {
                            SettleAction::Release => e.single_ok(caller),
                            SettleAction::Refund => timeout || e.single_ok(caller),
                        };
                    if expect_ok {
                        assert_eq!(got, Ok(()), "op {k} on escrow {}", e.id);
                        escrows[t].status = match action {
                            SettleAction::Release => EscrowStatus::Released,
                            SettleAction::Refund => EscrowStatus::Refunded,
                        };
                    } else {
                        assert!(got.is_err(), "op {k} wrongly settled escrow {}", e.id);
                        // A repeat of an escrow this batch already settled.
                        if !e.funded() {
                            assert_eq!(got, Err(Error::NotFunded));
                        }
                    }
                }
                // Every escrow whose ops all failed is exactly as it was.
                for (k, e) in escrows.iter().enumerate() {
                    if !picked
                        .iter()
                        .zip(results.iter())
                        .any(|((t, _), r)| *t == Some(k) && r.is_ok())
                    {
                        assert_eq!(
                            e.status, snapshot[k].status,
                            "Err op changed escrow {}",
                            e.id
                        );
                    }
                }
            }
        }
        world.check(&escrows);
    }
}

fuzz_target!(|data: &[u8]| run(data));
