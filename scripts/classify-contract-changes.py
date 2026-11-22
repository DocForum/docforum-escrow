#!/usr/bin/env python3
"""Classify contract interface changes (additive vs breaking) against base ref,
and require a semver bump note (bump: major in contract-changes.d/) for breaking changes.
"""
import json
import os
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[1]


def run_git(args: list[str]) -> subprocess.CompletedProcess:
    is_win = sys.platform == "win32"
    return subprocess.run(["git"] + args, capture_output=True, text=True, shell=is_win)


def resolve_base_ref(given_ref: str | None) -> str | None:
    candidates = []
    if given_ref:
        candidates.extend([given_ref, f"origin/{given_ref}", f"upstream/{given_ref}"])
    base = os.environ.get("GITHUB_BASE_REF")
    if base:
        candidates.extend([f"origin/{base}", f"upstream/{base}", base])
    candidates.extend(["origin/main", "upstream/main", "main"])

    for cand in candidates:
        res = run_git(["rev-parse", "--verify", cand])
        if res.returncode == 0:
            return cand
    return None


def get_base_spec(base_ref: str | None) -> dict | None:
    if not base_ref:
        return None
    try:
        res = run_git(["show", f"{base_ref}:contract-spec.json"])
        if res.returncode == 0 and res.stdout.strip():
            return json.loads(res.stdout)
    except Exception:
        pass
    return None


def read_contract_change_fragments() -> list[dict]:
    frag_dir = root / "contract-changes.d"
    if not frag_dir.exists():
        return []
    fragments = []
    for f in frag_dir.glob("*.md"):
        if f.name == "README.md":
            continue
        text = f.read_text(encoding="utf-8")
        lines = text.strip().splitlines()
        bump = None
        for line in lines:
            if line.startswith("bump:"):
                bump = line.split(":", 1)[1].strip()
                break
        fragments.append({"file": f.name, "bump": bump})
    return fragments


def classify_changes(base_spec: dict, curr_spec: dict) -> tuple[list[str], list[str]]:
    old_fns = {f["name"]: f for f in base_spec.get("functions", [])}
    new_fns = {f["name"]: f for f in curr_spec.get("functions", [])}
    old_errors = {e["name"]: e["code"] for e in base_spec.get("errors", [])}
    new_errors = {e["name"]: e["code"] for e in curr_spec.get("errors", [])}

    breaking = []
    additive = []

    # 1. Functions
    for name, old_f in old_fns.items():
        if name not in new_fns:
            breaking.append(f"Function '{name}' was removed")
        else:
            new_f = new_fns[name]
            if old_f["args"] != new_f["args"]:
                breaking.append(f"Function '{name}' arguments changed: ({old_f['args']}) -> ({new_f['args']})")
            if old_f["return"] != new_f["return"]:
                breaking.append(f"Function '{name}' return type changed: '{old_f['return']}' -> '{new_f['return']}'")

    for name in new_fns:
        if name not in old_fns:
            additive.append(f"New function '{name}' added")

    # 2. Errors
    for name, code in old_errors.items():
        if name not in new_errors:
            breaking.append(f"Error variant '{name}' (= {code}) removed (violates append-only)")
        elif new_errors[name] != code:
            breaking.append(f"Error variant '{name}' renumbered ({code} -> {new_errors[name]}) (violates append-only)")

    for name, code in new_errors.items():
        if name not in old_errors:
            additive.append(f"New error variant '{name}' (= {code}) added")

    return breaking, additive


def main():
    base_ref_arg = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] else None
    base_ref = resolve_base_ref(base_ref_arg)

    curr_spec_path = root / "contract-spec.json"
    if not curr_spec_path.exists():
        sys.exit("error: contract-spec.json not found")
    curr_spec = json.loads(curr_spec_path.read_text(encoding="utf-8"))

    base_spec = get_base_spec(base_ref)
    if not base_spec:
        print("Notice: No base spec found to compare against. Assuming no interface changes.")
        sys.exit(0)

    breaking, additive = classify_changes(base_spec, curr_spec)

    if not breaking and not additive:
        print("Contract interface: no changes detected against base.")
        sys.exit(0)

    fragments = read_contract_change_fragments()

    if breaking:
        print("=" * 60, file=sys.stderr)
        print("BREAKING CONTRACT INTERFACE CHANGES DETECTED:", file=sys.stderr)
        for b in breaking:
            print(f"  - {b}", file=sys.stderr)
        print("=" * 60, file=sys.stderr)

        has_major_bump = any(f["bump"] == "major" for f in fragments)
        if not has_major_bump:
            print("error: Breaking contract interface changes require a semver bump note.", file=sys.stderr)
            print("Please add a fragment under contract-changes.d/<issue>-<slug>.md with:", file=sys.stderr)
            print("  bump: major", file=sys.stderr)
            print("  ---", file=sys.stderr)
            print("  <summary of breaking changes>", file=sys.stderr)
            sys.exit(1)
        else:
            print("OK: Breaking interface changes declared with 'bump: major' fragment.")

    elif additive:
        print("=" * 60)
        print("ADDITIVE CONTRACT INTERFACE CHANGES DETECTED:")
        for a in additive:
            print(f"  + {a}")
        print("=" * 60)

        has_minor_or_major = any(f["bump"] in ("minor", "major") for f in fragments)
        if not has_minor_or_major:
            print("error: Additive contract interface changes require a semver bump note.", file=sys.stderr)
            print("Please add a fragment under contract-changes.d/<issue>-<slug>.md with:", file=sys.stderr)
            print("  bump: minor", file=sys.stderr)
            print("  ---", file=sys.stderr)
            print("  <summary of additive changes>", file=sys.stderr)
            sys.exit(1)
        else:
            print(f"OK: Additive interface changes declared with '{[f['bump'] for f in fragments]}' fragment.")


if __name__ == "__main__":
    main()
