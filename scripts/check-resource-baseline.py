#!/usr/bin/env python3
"""Fail when measured Soroban costs regress past the reviewed baseline.

Issue #319: this used to compare a function's *source text* size, so a change
that doubled a function's cost while shrinking its source passed. It now
compares the measured `cpu_instructions` / `memory_bytes` that
`cargo bench --bench resource_profile` writes as JSON against
`benchmarks/baseline.json`, and fails past `threshold_percent`.

The baseline is only ever updated by `scripts/update-resource-baseline.py`, so
a regression shows up here instead of being absorbed silently.

    cargo bench --bench resource_profile -- --out benchmarks/resource-profile.json
    python3 scripts/check-resource-baseline.py
"""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SNAPSHOT_FORMAT = 1
BASELINE_FORMAT = 3
FIELDS = ("cpu_instructions", "memory_bytes")


def fail(message):
    raise SystemExit(f"resource baseline: {message}")


def load_json(path):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        fail(f"missing {path.relative_to(ROOT)}")
    except json.JSONDecodeError as error:
        fail(f"{path.relative_to(ROOT)} is not valid JSON: {error}")


def contract_public_functions():
    """Every `pub fn` in the contract, following `mod name;` like the compiler."""
    src_dir = ROOT / "contracts/escrow/src"

    def expand(text):
        return re.sub(
            r"(?m)^mod ([a-z_][a-z0-9_]*);$",
            lambda match: expand((src_dir / f"{match.group(1)}.rs").read_text()),
            text,
        )

    source = expand((src_dir / "lib.rs").read_text())
    return set(re.findall(r"pub\s+fn\s+([a-z_][a-z0-9_]*)\b", source))


def change_percent(measured, baseline):
    if baseline == 0:
        return 0.0 if measured == 0 else float("inf")
    return (measured - baseline) / baseline * 100


def main():
    profile_path = ROOT / "benchmarks/resource-profile.json"
    baseline_path = ROOT / "benchmarks/baseline.json"

    snapshot = load_json(profile_path)
    baseline = load_json(baseline_path)

    if snapshot.get("format") != SNAPSHOT_FORMAT:
        fail(
            f"{profile_path.relative_to(ROOT)} has format {snapshot.get('format')!r}, "
            f"expected {SNAPSHOT_FORMAT}; regenerate it with the profile bench"
        )
    if baseline.get("format") != BASELINE_FORMAT:
        fail(
            f"benchmarks/baseline.json has format {baseline.get('format')!r}, expected "
            f"{BASELINE_FORMAT}; rewrite it with scripts/update-resource-baseline.py"
        )

    threshold = baseline["threshold_percent"]
    measured = snapshot.get("functions") or {}
    expected = baseline.get("functions") or {}
    if not expected:
        fail("benchmarks/baseline.json profiles no functions")

    public = contract_public_functions()
    stale = sorted(name for name in expected if name not in public)
    if stale:
        fail(f"baselined functions that are no longer public contract functions: {', '.join(stale)}")

    missing = sorted(name for name in expected if name not in measured)
    unexpected = sorted(name for name in measured if name not in expected)
    if missing:
        fail(
            "the profile did not measure: "
            + ", ".join(missing)
            + "\n  Is the function still in the profile bench? Drop it from the baseline with"
            "\n  scripts/update-resource-baseline.py --drop <name> --note <why>."
        )
    if unexpected:
        fail(
            "the profile measured functions with no baseline: "
            + ", ".join(unexpected)
            + "\n  Run scripts/update-resource-baseline.py --note <why> so a reviewer sees the new cost."
        )

    regressions = []
    improvements = []
    print(f"{'function':<32} {'cost':<17} {'baseline':>12} {'measured':>12} {'change':>9}")
    for name in sorted(expected):
        for field in FIELDS:
            limit = expected[name].get(field)
            value = measured[name].get(field)
            if not isinstance(limit, int):
                fail(f"benchmarks/baseline.json is missing an integer {field} for {name}")
            if not isinstance(value, int):
                fail(f"the profile is missing an integer {field} for {name}")
            change = change_percent(value, limit)
            print(f"{name:<32} {field:<17} {limit:>12} {value:>12} {change:>8.1f}%")
            if change > threshold:
                regressions.append(f"{name}.{field}: {limit} -> {value} ({change:+.1f}%, limit {threshold}%)")
            elif change < -threshold:
                improvements.append(f"{name}.{field}: {limit} -> {value} ({change:+.1f}%)")

    if regressions:
        print("\nMeasured resource regressions past the threshold:", file=sys.stderr)
        for regression in regressions:
            print(f"  {regression}", file=sys.stderr)
        print(
            "\nEither bring the cost back below the threshold, or, if the increase is "
            "reviewed and intended, regenerate the baseline with\n"
            "  scripts/update-resource-baseline.py --note \"why this cost is accepted\"\n"
            "and say so in the PR description.",
            file=sys.stderr,
        )
        return 1

    if improvements:
        print(
            "\nCost improved by more than the threshold; consider re-baselining so the win is "
            "locked in:\n  " + "\n  ".join(improvements),
            file=sys.stderr,
        )

    print(
        f"\nresource baseline covers {len(expected)} profiled public functions "
        f"(threshold {threshold}%, {snapshot.get('runs', 1)} identical runs)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
