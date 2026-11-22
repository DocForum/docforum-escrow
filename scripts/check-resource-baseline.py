#!/usr/bin/env python3
import json,re
from pathlib import Path

root = Path(__file__).resolve().parents[1]
def contract_source(root):
    """lib.rs with every `mod name;` replaced by src/name.rs, i.e. the contract in source order."""
    import re
    src_dir = root / "contracts/escrow/src"
    def expand(text):
        return re.sub(r"(?m)^mod ([a-z_][a-z0-9_]*);$", lambda m: expand((src_dir / f"{m.group(1)}.rs").read_text()), text)
    return expand((src_dir / "lib.rs").read_text())
src = contract_source(root)
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
