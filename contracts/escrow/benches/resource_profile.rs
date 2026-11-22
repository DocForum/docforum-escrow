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

use docforum_escrow::{EscrowContract, EscrowContractClient};
use soroban_sdk::{testutils::Address as _, token::StellarAssetClient, Address, Env, String, Vec};

/// Format of the JSON this bench writes; `--out` consumers check it.
const SNAPSHOT_FORMAT: u32 = 1;
const DEFAULT_RUNS: usize = 2;

const PROFILE_METHOD: &str =
    "Soroban native budget; one successful call per fresh environment; setup excluded; every run must match";

struct Fixture<'a> {
    env: Env,
    client: EscrowContractClient<'a>,
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
    // The constructor also takes the immutable pause admin (docs/adr/0011);
    // the profile never pauses, so any address will do.
    let pause_admin = Address::generate(&env);
    let contract = env.register(EscrowContract, (Vec::<Address>::new(&env), pause_admin));
    let client = EscrowContractClient::new(&env, &contract);
    Fixture {
        env,
        client,
        payer,
        payee,
        releaser,
        token,
    }
}

impl Fixture<'_> {
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

    measurements
}

/// Explain why two runs disagree, if they do.
fn determinism_failure(first: &[Measurement], other: &[Measurement], run: usize) -> Option<StdString> {
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
        let comma = if index + 1 == measurements.len() { "" } else { "," };
        let _ = writeln!(json, "{}{comma}", measurement.to_json());
    }
    let _ = writeln!(json, "  }}");
    let _ = writeln!(json, "}}");
    json
}

fn print_table(measurements: &[Measurement]) {
    eprintln!("{:<32} {:>12} {:>12}", "function", "cpu_insns", "memory_bytes");
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
                return Err("usage: cargo bench --bench resource_profile -- [--out <path>] [--runs <n>]".to_string())
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
