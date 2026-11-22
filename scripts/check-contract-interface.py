#!/usr/bin/env python3
"""Deterministically snapshot the public Rust contract interface and error codes,
and assert error codes are append-only.
"""
import json
import os
from pathlib import Path
import re
import subprocess
import sys

root = Path(__file__).resolve().parents[1]


# Provisional error codes (>= 1000, contract-changes.d/README.md) are never
# released: the maintainer fold renumbers them to final codes before a deploy.
# That one move, provisional -> final, is not a renumbering of a released code.
PROVISIONAL_MIN = 1000


def is_fold_renumbering(old_code, new_code):
    return old_code >= PROVISIONAL_MIN and new_code < PROVISIONAL_MIN


def contract_source(root_path: Path) -> str:
    """lib.rs with every `mod name;` replaced by src/name.rs, stripped of comments."""
    src_dir = root_path / "contracts/escrow/src"

    def expand(text: str) -> str:
        return re.sub(
            r"(?m)^mod ([a-z_][a-z0-9_]*);$",
            lambda m: expand((src_dir / f"{m.group(1)}.rs").read_text(encoding="utf-8")),
            text,
        )

    raw = expand((src_dir / "lib.rs").read_text(encoding="utf-8"))
    # Strip block comments /* ... */ and line comments // ... so doc comments
    # do not count as interface changes.
    no_blocks = re.sub(r"/\*[\s\S]*?\*/", "", raw)
    clean = re.sub(r"//.*$", "", no_blocks, flags=re.MULTILINE)
    return clean


def extract_spec(root_path: Path) -> dict:
    src = contract_source(root_path)
    functions = []
    for m in re.finditer(r"pub\s+fn\s+([A-Za-z0-9_]+)\s*\((.*?)\)(?:\s*->\s*([^\{]+))?", src, re.S):
        args = " ".join(m.group(2).split())
        ret = " ".join((m.group(3) or "").split())
        functions.append({"name": m.group(1), "args": args, "return": ret})

    errors = []
    block = re.search(r"pub enum Error\s*\{(.*?)\n\}", src, re.S)
    if block:
        for line in block.group(1).splitlines():
            m = re.search(r"^\s*([A-Za-z0-9_]+)\s*=\s*(\d+)", line)
            if m:
                errors.append({"name": m.group(1), "code": int(m.group(2))})

    return {"format": 1, "functions": functions, "errors": errors}


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


def assert_append_only(curr_spec: dict, base_ref: str | None = None) -> None:
    errors = curr_spec.get("errors", [])
    codes = [e["code"] for e in errors]
    names = [e["name"] for e in errors]

    if any(c <= 0 for c in codes):
        sys.exit("error: error codes must be positive integers")
    if len(codes) != len(set(codes)):
        seen = {}
        for e in errors:
            if e["code"] in seen:
                sys.exit(f"error: duplicate error code {e['code']} used by '{seen[e['code']]}' and '{e['name']}'")
            seen[e["code"]] = e["name"]
    if len(names) != len(set(names)):
        sys.exit("error: duplicate error variant names found in spec")

    base_ref = resolve_base_ref(base_ref)
    base_spec = get_base_spec(base_ref)
    if not base_spec:
        return

    old_errors = {e["name"]: e["code"] for e in base_spec.get("errors", [])}
    old_codes = {e["code"]: e["name"] for e in base_spec.get("errors", [])}
    new_errors = {e["name"]: e["code"] for e in errors}
    new_codes = {e["code"]: e["name"] for e in errors}

    problems = []
    for name, code in old_errors.items():
        if name not in new_errors:
            problems.append(f"Error::{name} (= {code}) was removed. Error codes are append-only.")
        elif new_errors[name] != code and not is_fold_renumbering(code, new_errors[name]):
            problems.append(f"Error::{name} was renumbered ({code} -> {new_errors[name]}). Error codes are append-only.")

    for code, old_name in old_codes.items():
        if code in new_codes and new_codes[code] != old_name:
            problems.append(
                f"Error code {code} (previously '{old_name}') was reused for '{new_codes[code]}'. "
                "Error codes must never be reused."
            )

    if problems:
        for p in problems:
            print(f"error: {p}", file=sys.stderr)
        sys.exit(1)


def main():
    args = sys.argv[1:]
    if not args:
        spec = extract_spec(root)
        print(json.dumps(spec, indent=2) + "\n")
        return

    if args[0] == "--assert-append-only":
        base_ref = args[1] if len(args) > 1 and args[1] else None
        spec_path = root / "contract-spec.json"
        spec = json.loads(spec_path.read_text(encoding="utf-8"))
        assert_append_only(spec, base_ref)
        print("error codes are append-only and unique")
        return

    if args[0] in ("--help", "-h"):
        print("Usage:")
        print("  check-contract-interface.py                   # Output spec JSON")
        print("  check-contract-interface.py --assert-append-only [base-ref]  # Verify append-only error codes")
        return


if __name__ == "__main__":
    main()
