#!/usr/bin/env python3
"""Rewrite benchmarks/baseline.json from a profile snapshot, deliberately.

The baseline is the reviewed record of what each profiled function is allowed
to cost. Raising it is a decision, so it is never derived implicitly by CI: it
takes this script, a `--note` explaining the change, and a sentence in the PR
description (see `benchmarks/resource-profile.md`).

    cd contracts/escrow
    cargo bench --bench resource_profile -- --out ../../benchmarks/resource-profile.json
    cd ../..
    python3 scripts/update-resource-baseline.py --note "why the cost moved"

`--dry-run` prints the new baseline and the per-function deltas without writing
anything. `--drop <name>` removes a function that left the profile, and
`--threshold <percent>` changes the allowed regression.
"""

import argparse
import json
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SNAPSHOT_FORMAT = 1
BASELINE_FORMAT = 3
FIELDS = ("cpu_instructions", "memory_bytes")


def fail(message):
    raise SystemExit(f"update-resource-baseline: {message}")


def parser():
    arg_parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    arg_parser.add_argument("--profile", default="benchmarks/resource-profile.json", help="profile snapshot to read")
    arg_parser.add_argument("--baseline", default="benchmarks/baseline.json", help="baseline to rewrite")
    arg_parser.add_argument("--note", required=True, help="why the baseline moved; reviewers read this in the diff")
    arg_parser.add_argument("--threshold", type=float, help="allowed regression in percent, default: keep the current one")
    arg_parser.add_argument(
        "--drop",
        action="append",
        default=[],
        metavar="FUNCTION",
        help="drop a baselined function that the profile no longer measures (repeatable)",
    )
    arg_parser.add_argument("--dry-run", action="store_true", help="print the result instead of writing it")
    return arg_parser


def load(path):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        fail(f"missing {path}")
    except json.JSONDecodeError as error:
        fail(f"{path} is not valid JSON: {error}")


def main(argv=None):
    args = parser().parse_args(argv)
    profile_path = ROOT / args.profile
    baseline_path = ROOT / args.baseline

    snapshot = load(profile_path)
    if snapshot.get("format") != SNAPSHOT_FORMAT:
        fail(f"{args.profile} has format {snapshot.get('format')!r}, expected {SNAPSHOT_FORMAT}")
    measured = snapshot.get("functions") or {}
    if not measured:
        fail(f"{args.profile} profiles no functions")

    baseline_path_exists = baseline_path.exists()
    previous = load(baseline_path) if baseline_path_exists else {"functions": {}, "threshold_percent": 20}
    previous_functions = previous.get("functions") or {}
    threshold = args.threshold if args.threshold is not None else previous.get("threshold_percent", 20)

    dropped = set(args.drop)
    unknown_drops = sorted(dropped - set(previous_functions))
    if unknown_drops:
        fail(f"--drop names functions that are not baselined: {', '.join(unknown_drops)}")
    still_measured = sorted(dropped & set(measured))
    if still_measured:
        fail(f"--drop names functions the profile still measures: {', '.join(still_measured)}")

    for name in sorted(set(previous_functions) - set(measured) - dropped):
        fail(
            f"{name} is baselined but the profile no longer measures it; "
            f"pass --drop {name} with a note if that is intended"
        )

    functions = {}
    print(f"{'function':<32} {'cost':<17} {'baseline':>12} {'measured':>12} {'change':>9}")
    for name in sorted(measured):
        entry = {}
        for field in FIELDS:
            value = measured[name].get(field)
            if not isinstance(value, int):
                fail(f"{args.profile} is missing an integer {field} for {name}")
            entry[field] = value
            old = previous_functions.get(name, {}).get(field)
            if isinstance(old, int) and old != 0:
                change = f"{(value - old) / old * 100:+.1f}%"
            else:
                change = "new"
            print(f"{name:<32} {field:<17} {str(old if old is not None else '-'):>12} {value:>12} {change:>9}")
        functions[name] = entry

    updated = {
        "format": BASELINE_FORMAT,
        "threshold_percent": threshold,
        "profile_method": snapshot.get("profile_method", previous.get("profile_method", "")),
        "last_update": {"date": date.today().isoformat(), "note": args.note},
        "functions": functions,
    }

    if dropped:
        print(f"\ndropped: {', '.join(sorted(dropped))}")

    text = json.dumps(updated, indent=2) + "\n"
    if args.dry_run:
        sys.stdout.write(text)
        print(f"\n(dry run: {args.baseline} not written)", file=sys.stderr)
        return 0

    baseline_path.write_text(text)
    print(f"\nwrote {args.baseline}; mention the move in the PR description")
    return 0


if __name__ == "__main__":
    sys.exit(main())
