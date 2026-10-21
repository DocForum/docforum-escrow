#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp=$(mktemp); trap 'rm -f "$tmp"' EXIT
python3 "$root/scripts/check-contract-interface.py" > "$tmp"
diff -u "$root/contract-spec.json" "$tmp"
python3 - "$root/contract-spec.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); codes=[e["code"] for e in d["errors"]]
if codes != sorted(set(codes)) or any(c <= 0 for c in codes): raise SystemExit("error codes must be positive, unique and sorted")
PY
echo 'contract interface snapshot is current'
