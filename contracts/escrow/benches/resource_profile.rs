#![allow(deprecated)]

//! Resource profile for the public escrow entry points.
//!
//! `cargo bench --bench resource_profile` measures the Soroban native budget for
//! one successful call per function and writes a machine-readable snapshot:
//!
//! ```text
//! {"format": 1, "profile_method": "...", "runs": 2, "functions": {
//!   "create_escrow": {"cpu_instructions": 494344, "memory_bytes": 167118}, ...}}
//! ```
//!
//! The JSON goes to stdout, or to a file with `--out <path>`; the human-readable
//! table goes to stderr so a redirect of stdout stays valid JSON. Each function
//! is measured in its own fresh environment, and the whole profile is measured
//! `--runs` times (default 2) and compared: identical numbers are what makes
//! `scripts/check-resource-baseline.py` trustworthy. `--runs 1` skips that check
//! for local experiments.
//!
//! See `benchmarks/resource-profile.md` and, for updating the baseline,
//! `scripts/update-resource-baseline.py`.

use std::fmt::Write as _;
use std::process::ExitCode;
// `soroban_sdk::{String, Vec}` are in scope for the contract calls below, so the
// std types this harness builds its output with are named explicitly.
use std::string::String as StdString;

use docforum_escrow::{
    CreateItem, EscrowContract, EscrowContractClient, SettleAction, MAX_BATCH_SIZE,
    MAX_CONDITION_REF_LEN, MAX_FEE_BPS, MAX_SETTLE_OPS,
};
use soroban_sdk::{
    contract, contracterror, contractimpl,
    testutils::{Address as _, Events as _, Ledger as _},
    token::StellarAssetClient,
    xdr::{Limits, WriteXdr},
    Address, Env, String, Vec,
};

/// Format of the JSON this bench writes; `--out` consumers check it.
const SNAPSHOT_FORMAT: u32 = 1;
const DEFAULT_RUNS: usize = 2;

/// Ledger time the pooled fixtures are created at; their funding deadline
/// follows it.
const CREATED_AT: u64 = 1_000;
const FUNDING_DEADLINE: u64 = CREATED_AT + 1_000;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
enum HookError {
    Rejected = 1,
}

/// A contract payee whose release callback succeeds. Used by the
/// `settle_many` profile so the worst case includes the cross-contract
/// `on_escrow_released` invoke, not just the token transfer.
#[contract]
struct PayeeHook;

#[contractimpl]
impl PayeeHook {
    pub fn on_escrow_released(_env: Env, _escrow_id: u64, _amount: i128) -> Result<(), HookError> {
        Ok(())
    }
}

const PROFILE_METHOD: &str =
    "Soroban native budget; one successful call per fresh environment; setup excluded; every run must match";

struct Fixture<'a> {
    env: Env,
    client: EscrowContractClient<'a>,
    pause_admin: Address,
    payer: Address,
    payee: Address,
    releaser: Address,
    token: Address,
}

fn fixture() -> Fixture<'static> {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let token = env.register_stellar_asset_contract_v2(admin).address();
    let asset = StellarAssetClient::new(&env, &token);
    let payer = Address::generate(&env);
    let payee = Address::generate(&env);
    let releaser = Address::generate(&env);
    asset.mint(&payer, &10_000);
    // The constructor also takes the immutable pause admin (docs/adr/0011).
    let pause_admin = Address::generate(&env);
    let contract = env.register(
        EscrowContract,
        (Vec::<Address>::new(&env), pause_admin.clone()),
    );
    let client = EscrowContractClient::new(&env, &contract);
    Fixture {
        env,
        client,
        pause_admin,
        payer,
        payee,
        releaser,
        token,
    }
}

impl Fixture<'_> {
    /// The longest `condition_ref` the contract accepts (threat model T10).
    fn long_ref(&self) -> String {
        String::from_str(&self.env, &"r".repeat(MAX_CONDITION_REF_LEN as usize))
    }

    fn create(&self) -> u64 {
        self.client.create_escrow(
            &self.payer,
            &self.payee,
            &self.token,
            &100,
            &String::from_str(&self.env, "resource-profile"),
            &self.releaser,
            &None,
            &false,
            &None,
            &None,
            &None,
        )
    }

    /// Worst-case settlement input: the maximum fee, an opted-in payee
    /// callback and the longest condition reference.
    fn create_fee_and_callback(&self, payee: &Address, amount: i128) -> u64 {
        self.client.create_escrow(
            &self.payer,
            payee,
            &self.token,
            &amount,
            &self.long_ref(),
            &self.releaser,
            &None,
            &true,
            &None,
            &Some(Address::generate(&self.env)),
            &Some(MAX_FEE_BPS),
        )
    }

    /// Worst-case releaser set: ten distinct addresses, threshold 1 (the
    /// highest threshold `settle_many` accepts), callback opted in and the
    /// longest condition reference.
    fn create_ten_releasers(&self, payee: &Address) -> u64 {
        let mut releasers = Vec::new(&self.env);
        releasers.push_back(self.releaser.clone());
        for _ in 1..10 {
            releasers.push_back(Address::generate(&self.env));
        }
        self.client.create_escrow_with_releasers(
            &self.payer,
            payee,
            &self.token,
            &1_000,
            &self.long_ref(),
            &releasers,
            &1,
            &None,
            &true,
            &None,
        )
    }

    /// Tops the payer up for the batch fixtures, which lock far more than the
    /// single-escrow default mint. Done here rather than in `fixture()` so
    /// the existing per-function baselines are measured exactly as before.
    fn fund_payer(&self) {
        StellarAssetClient::new(&self.env, &self.token).mint(&self.payer, &10_000_000);
    }

    fn create_pooled(&self, target: i128) -> u64 {
        self.env.ledger().set_timestamp(CREATED_AT);
        self.client.create_pooled_escrow(
            &self.payer,
            &self.payee,
            &self.token,
            &target,
            &self.long_ref(),
            &self.releaser,
            &FUNDING_DEADLINE,
        )
    }
}

/// One measured function, in the order it was profiled.
struct Measurement {
    name: &'static str,
    cpu_instructions: u64,
    memory_bytes: u64,
}

impl Measurement {
    fn to_json(&self) -> StdString {
        format!(
            "        {:?}: {{\"cpu_instructions\": {}, \"memory_bytes\": {}}}",
            self.name, self.cpu_instructions, self.memory_bytes
        )
    }
}

fn measure(name: &'static str, env: &Env, operation: impl FnOnce()) -> Measurement {
    env.cost_estimate().budget().reset_tracker();
    operation();
    Measurement {
        name,
        cpu_instructions: env.cost_estimate().budget().cpu_instruction_cost(),
        memory_bytes: env.cost_estimate().budget().memory_bytes_cost(),
    }
}

/// Like `measure`, plus (on stderr) the ledger footprint the call modelled and
/// the XDR size of the events it emitted. For the batch entry points those are
/// the Mainnet per-transaction limits a batch can hit (docs/adr/0012).
fn measure_with_events(name: &'static str, env: &Env, operation: impl FnOnce()) -> Measurement {
    let measurement = measure(name, env, operation);
    let resources = env.cost_estimate().resources();
    let events_bytes: usize = env
        .events()
        .all()
        .events()
        .iter()
        .map(|event| event.to_xdr(Limits::none()).unwrap().len())
        .sum();
    eprintln!(
        "{name}: cpu_insns={}, memory_bytes={}, events_bytes={events_bytes}, write_entries={}, write_bytes={}",
        measurement.cpu_instructions,
        measurement.memory_bytes,
        resources.write_entries,
        resources.write_bytes,
    );
    measurement
}

/// Measure every profiled function once, each in its own fresh environment.
fn profile_once() -> std::vec::Vec<Measurement> {
    let mut measurements: std::vec::Vec<Measurement> = std::vec::Vec::new();

    let f = fixture();
    measurements.push(measure("create_escrow", &f.env, || {
        f.create();
    }));

    let f = fixture();
    measurements.push(measure("create_escrow_release_time", &f.env, || {
        f.client.create_escrow_release_time(
            &f.payer,
            &f.payee,
            &f.token,
            &100,
            &String::from_str(&f.env, "resource-profile"),
            &f.releaser,
            &None,
            &false,
            &None,
            &Some(1_000),
            &None,
            &None,
        );
    }));

    let f = fixture();
    measurements.push(measure("create_escrow_with_acceptance", &f.env, || {
        f.client.create_escrow_with_acceptance(
            &f.payer,
            &f.payee,
            &f.token,
            &100,
            &String::from_str(&f.env, "resource-profile"),
            &f.releaser,
            &None,
            &true,
            &None,
        );
    }));

    let f = fixture();
    let releasers = soroban_sdk::vec![&f.env, f.releaser.clone()];
    measurements.push(measure("create_escrow_with_releasers", &f.env, || {
        f.client.create_escrow_with_releasers(
            &f.payer,
            &f.payee,
            &f.token,
            &100,
            &String::from_str(&f.env, "resource-profile"),
            &releasers,
            &1,
            &None,
            &false,
            &None,
        );
    }));

    let f = fixture();
    let id = f.client.create_escrow_with_acceptance(
        &f.payer,
        &f.payee,
        &f.token,
        &100,
        &String::from_str(&f.env, "resource-profile"),
        &f.releaser,
        &None,
        &true,
        &None,
    );
    measurements.push(measure("accept", &f.env, || {
        f.client.accept(&id, &f.payee);
    }));

    let f = fixture();
    let id = f.create();
    measurements.push(measure("get_status", &f.env, || {
        f.client.get_status(&id);
    }));

    let f = fixture();
    let id = f.create();
    measurements.push(measure("get_escrow", &f.env, || {
        f.client.get_escrow(&id);
    }));

    let f = fixture();
    let id = f.create();
    let replacement = Address::generate(&f.env);
    measurements.push(measure("rotate_releaser", &f.env, || {
        f.client.rotate_releaser(&id, &f.releaser, &replacement);
    }));

    let f = fixture();
    let id = f.create();
    measurements.push(measure("top_up", &f.env, || {
        f.client.top_up(&id, &f.payer, &10);
    }));

    let f = fixture();
    let id = f.create();
    measurements.push(measure("release", &f.env, || {
        f.client.release(&id, &f.releaser);
    }));

    let f = fixture();
    let id = f.client.create_escrow_with_releasers(
        &f.payer,
        &f.payee,
        &f.token,
        &100,
        &String::from_str(&f.env, "resource-profile"),
        &soroban_sdk::vec![&f.env, f.releaser.clone()],
        &1,
        &None,
        &false,
        &None,
    );
    let approvers = soroban_sdk::vec![&f.env, f.releaser.clone()];
    measurements.push(measure("release_with_approvals", &f.env, || {
        f.client.release_with_approvals(&id, &approvers);
    }));

    let f = fixture();
    let id = f.create();
    measurements.push(measure("refund", &f.env, || {
        f.client.refund(&id, &f.releaser);
    }));

    let f = fixture();
    let id = f.client.create_escrow_with_releasers(
        &f.payer,
        &f.payee,
        &f.token,
        &100,
        &String::from_str(&f.env, "resource-profile"),
        &soroban_sdk::vec![&f.env, f.releaser.clone()],
        &1,
        &None,
        &false,
        &None,
    );
    let approvers = soroban_sdk::vec![&f.env, f.releaser.clone()];
    measurements.push(measure("refund_with_approvals", &f.env, || {
        f.client.refund_with_approvals(&id, &approvers);
    }));

    // Worst-case batch: MAX_BATCH_SIZE items, each with a distinct payee,
    // the longest condition reference and a refund deadline set.
    let f = fixture();
    f.fund_payer();
    let mut items = Vec::new(&f.env);
    for _ in 0..MAX_BATCH_SIZE {
        items.push_back(CreateItem {
            payee: Address::generate(&f.env),
            token: f.token.clone(),
            amount: 1_000,
            condition_ref: f.long_ref(),
            releaser: f.releaser.clone(),
            refund_after: Some(u64::MAX),
        });
    }
    f.env.cost_estimate().budget().reset_unlimited();
    measurements.push(measure_with_events("create_escrows", &f.env, || {
        let ids = f.client.create_escrows(&f.payer, &items);
        assert_eq!(ids.len(), MAX_BATCH_SIZE);
    }));

    // Worst-case batch: MAX_SETTLE_OPS releases, each escrow carrying the
    // maximum fee and an opted-in payee callback, with the longest
    // condition reference.
    let f = fixture();
    f.fund_payer();
    let hook = f.env.register(PayeeHook, ());
    let mut ops = Vec::new(&f.env);
    for _ in 0..MAX_SETTLE_OPS {
        let id = f.create_fee_and_callback(&hook, 1_000);
        ops.push_back((id, SettleAction::Release));
    }
    f.env.cost_estimate().budget().reset_unlimited();
    measurements.push(measure_with_events("settle_many", &f.env, || {
        let results = f.client.settle_many(&f.releaser, &ops);
        assert_eq!(results.len(), MAX_SETTLE_OPS);
        assert!(results.iter().all(|r| r.is_ok()));
    }));

    // Releaser-set comparison for the same worst-case batch size. A protocol
    // fee and a ten-address releaser set cannot both be set at creation
    // (only `create_escrow*` takes a fee), so the fee + callback shape above
    // is the baseline and this measures the other expensive dimension.
    let f = fixture();
    f.fund_payer();
    let hook = f.env.register(PayeeHook, ());
    let mut ops = Vec::new(&f.env);
    for _ in 0..MAX_SETTLE_OPS {
        let id = f.create_ten_releasers(&hook);
        ops.push_back((id, SettleAction::Release));
    }
    f.env.cost_estimate().budget().reset_unlimited();
    // Printed on stderr only: the baseline holds one entry per public function.
    let _ = measure_with_events("settle_many_ten_releasers", &f.env, || {
        let results = f.client.settle_many(&f.releaser, &ops);
        assert_eq!(results.len(), MAX_SETTLE_OPS);
        assert!(results.iter().all(|r| r.is_ok()));
    });

    let f = fixture();
    measurements.push(measure("create_pooled_escrow", &f.env, || {
        f.create_pooled(1_000);
    }));

    let f = fixture();
    let id = f.create_pooled(1_000);
    let contributor = Address::generate(&f.env);
    StellarAssetClient::new(&f.env, &f.token).mint(&contributor, &1_000);
    measurements.push(measure("contribute", &f.env, || {
        f.client.contribute(&id, &contributor, &1_000);
    }));

    // A failed round: the deadline has passed with the target unmet, so the
    // contributor pulls their full recorded amount back.
    let f = fixture();
    let id = f.create_pooled(1_000);
    let contributor = Address::generate(&f.env);
    StellarAssetClient::new(&f.env, &f.token).mint(&contributor, &400);
    f.client.contribute(&id, &contributor, &400);
    f.env.ledger().set_timestamp(FUNDING_DEADLINE);
    measurements.push(measure("claim_refund", &f.env, || {
        f.client.claim_refund(&id, &contributor);
    }));

    let f = fixture();
    let id = f.client.create_escrow_with_acceptance(
        &f.payer,
        &f.payee,
        &f.token,
        &100,
        &String::from_str(&f.env, "resource-profile"),
        &f.releaser,
        &None,
        &true,
        &None,
    );
    measurements.push(measure("cancel", &f.env, || {
        f.client.cancel(&id, &f.payer);
    }));

    let f = fixture();
    let id = f.create();
    let new_payee = Address::generate(&f.env);
    measurements.push(measure("transfer_payee", &f.env, || {
        f.client.transfer_payee(&id, &f.payee, &new_payee);
    }));

    let f = fixture();
    measurements.push(measure("pause", &f.env, || {
        f.client.pause(&f.pause_admin);
    }));

    let f = fixture();
    f.client.pause(&f.pause_admin);
    measurements.push(measure("unpause", &f.env, || {
        f.client.unpause(&f.pause_admin);
    }));

    // Two funded escrows so the liability read is not trivially zero.
    let f = fixture();
    f.create();
    f.create();
    measurements.push(measure("solvency", &f.env, || {
        f.client.solvency(&f.token);
    }));

    measurements
}

/// Explain why two runs disagree, if they do.
fn determinism_failure(
    first: &[Measurement],
    other: &[Measurement],
    run: usize,
) -> Option<StdString> {
    if first.len() != other.len() {
        return Some(format!(
            "run 1 profiled {} functions but run {} profiled {}",
            first.len(),
            run,
            other.len()
        ));
    }
    for (a, b) in first.iter().zip(other) {
        if a.name != b.name {
            return Some(format!(
                "run 1 measured {:?} where run {} measured {:?}",
                a.name, run, b.name
            ));
        }
        if a.cpu_instructions != b.cpu_instructions || a.memory_bytes != b.memory_bytes {
            return Some(format!(
                "{:?}: run 1 measured cpu_instructions={} memory_bytes={}, run {} measured cpu_instructions={} memory_bytes={}",
                a.name,
                a.cpu_instructions,
                a.memory_bytes,
                run,
                b.cpu_instructions,
                b.memory_bytes
            ));
        }
    }
    None
}

fn snapshot_json(measurements: &[Measurement], runs: usize) -> StdString {
    let mut json = StdString::new();
    let _ = writeln!(json, "{{");
    let _ = writeln!(json, "  \"format\": {SNAPSHOT_FORMAT},");
    let _ = writeln!(json, "  \"profile_method\": {PROFILE_METHOD:?},");
    let _ = writeln!(json, "  \"runs\": {runs},");
    let _ = writeln!(json, "  \"functions\": {{");
    for (index, measurement) in measurements.iter().enumerate() {
        let comma = if index + 1 == measurements.len() {
            ""
        } else {
            ","
        };
        let _ = writeln!(json, "{}{comma}", measurement.to_json());
    }
    let _ = writeln!(json, "  }}");
    let _ = writeln!(json, "}}");
    json
}

fn print_table(measurements: &[Measurement]) {
    eprintln!(
        "{:<32} {:>12} {:>12}",
        "function", "cpu_insns", "memory_bytes"
    );
    for measurement in measurements {
        eprintln!(
            "{:<32} {:>12} {:>12}",
            measurement.name, measurement.cpu_instructions, measurement.memory_bytes
        );
    }
}

struct Options {
    out: Option<StdString>,
    runs: usize,
}

fn parse_options(mut args: impl Iterator<Item = StdString>) -> Result<Options, StdString> {
    let mut options = Options {
        out: None,
        runs: DEFAULT_RUNS,
    };
    while let Some(arg) = args.next() {
        match arg.as_str() {
            // cargo passes `--bench` to a `harness = false` binary.
            "--bench" => continue,
            "--out" => {
                options.out = Some(
                    args.next()
                        .ok_or_else(|| "--out needs a path".to_string())?,
                );
            }
            "--runs" => {
                let value = args
                    .next()
                    .ok_or_else(|| "--runs needs a count".to_string())?;
                options.runs = value
                    .parse()
                    .map_err(|_| format!("--runs expects a positive integer, got {value:?}"))?;
                if options.runs == 0 {
                    return Err("--runs expects a positive integer, got 0".to_string());
                }
            }
            "--help" | "-h" => {
                return Err(
                    "usage: cargo bench --bench resource_profile -- [--out <path>] [--runs <n>]"
                        .to_string(),
                )
            }
            other => return Err(format!("unknown argument {other:?}")),
        }
    }
    Ok(options)
}

fn run() -> Result<(), StdString> {
    let options = parse_options(std::env::args().skip(1))?;
    if options.runs == 1 {
        eprintln!("warning: --runs 1 skips the determinism check");
    }

    let runs: std::vec::Vec<std::vec::Vec<Measurement>> =
        (0..options.runs).map(|_| profile_once()).collect();
    let first = &runs[0];
    for (index, other) in runs.iter().enumerate().skip(1) {
        if let Some(failure) = determinism_failure(first, other, index + 1) {
            return Err(format!(
                "resource profile is not deterministic: {failure}\n\
                 The baseline check depends on identical numbers, so fix the measurement before relying on it."
            ));
        }
    }

    print_table(first);
    let json = snapshot_json(first, options.runs);
    match options.out {
        Some(path) => std::fs::write(&path, format!("{json}\n"))
            .map_err(|error| format!("can't write {path}: {error}"))?,
        None => println!("{json}"),
    }
    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{message}");
            ExitCode::FAILURE
        }
    }
}
