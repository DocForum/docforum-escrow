use std::{env, fs, path::PathBuf};

fn main() {
    println!("cargo:rerun-if-env-changed=DOCFORUM_GIT_SHA");
    println!("cargo:rerun-if-env-changed=GITHUB_SHA");
    println!("cargo:rerun-if-changed=Cargo.lock");

    // Build metadata must not depend on wall-clock time. CI supplies the
    // immutable checkout SHA; local/reproducible builds without it are
    // explicitly marked unknown instead of probing mutable git state.
    let git_sha = env::var("DOCFORUM_GIT_SHA")
        .or_else(|_| env::var("GITHUB_SHA"))
        .unwrap_or_else(|_| "unknown".to_owned());
    let sdk_version = locked_dependency_version("soroban-sdk");
    let generated = format!(
        "soroban_sdk::contractmeta!(key = \"git_sha\", val = {:?});\n\
         soroban_sdk::contractmeta!(key = \"soroban_sdk_version\", val = {:?});\n",
        git_sha, sdk_version
    );
    let output = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR is set by Cargo"));
    fs::write(output.join("contract_metadata.rs"), generated)
        .expect("write generated contract metadata");
}

fn locked_dependency_version(name: &str) -> String {
    let lock_path =
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("manifest dir")).join("Cargo.lock");
    let lock = fs::read_to_string(lock_path).expect("read Cargo.lock for build metadata");
    let mut in_package = false;
    for line in lock.lines() {
        if line == "[[package]]" {
            in_package = false;
        } else if line == format!("name = \"{name}\"") {
            in_package = true;
        } else if in_package && line.starts_with("version = ") {
            return line
                .trim_start_matches("version = \"")
                .trim_end_matches('"')
                .to_owned();
        }
    }
    panic!("{name} must be pinned in Cargo.lock");
}
