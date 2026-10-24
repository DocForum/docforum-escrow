#!/usr/bin/env python3
import json,re
from pathlib import Path

root = Path(__file__).resolve().parents[1]
src = (root / "contracts/escrow/src/lib.rs").read_text()
baseline = json.loads((root / "benchmarks/baseline.json").read_text())
profile_fields = ("cpu_instructions", "memory_bytes")

for name, old in baseline["functions"].items():
    match = re.search(
        r"pub\s+fn\s+" + re.escape(name) + r"\b(.*?)(?=\n\s*pub\s+fn|\n\s*})",
        src,
        re.S,
    )
    if not match:
        raise SystemExit(f"missing public function: {name}")

    source_bytes = len(match.group(0).encode())
    if source_bytes > old["source_bytes"] * (100 + baseline["threshold_percent"]) / 100:
        raise SystemExit(f"{name} exceeds source-size baseline")

    for revision in ("before", "after"):
        profile = old.get("profile", {}).get(revision)
        if not profile or any(not isinstance(profile.get(field), int) for field in profile_fields):
            raise SystemExit(f"{name} is missing {revision} resource measurements")

print("resource baseline covers", len(baseline["functions"]), "profiled public functions")
