#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
base_ref="${1:-${GITHUB_BASE_REF:-}}"

# If running in GitHub Actions PR from a fork or shallow checkout, fetch base ref
if [ -n "${GITHUB_BASE_REF:-}" ]; then
  git fetch origin "$GITHUB_BASE_REF":refs/remotes/origin/"$GITHUB_BASE_REF" 2>/dev/null || true
  base_ref="origin/$GITHUB_BASE_REF"
fi

tmp=$(mktemp); trap 'rm -f "$tmp"' EXIT
python3 "$root/scripts/check-contract-interface.py" > "$tmp"
diff -u "$root/contract-spec.json" "$tmp"

python3 "$root/scripts/check-contract-interface.py" --assert-append-only "$base_ref"
python3 "$root/scripts/classify-contract-changes.py" "$base_ref"

echo 'contract interface snapshot is current and valid'
