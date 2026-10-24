#!/usr/bin/env python3
import json,re
from pathlib import Path
root=Path(__file__).resolve().parents[1]; src=(root/"contracts/escrow/src/lib.rs").read_text(); baseline=json.loads((root/"benchmarks/baseline.json").read_text())
for name,old in baseline["functions"].items():
 m=re.search(r"pub\s+fn\s+"+re.escape(name)+r"\b(.*?)(?=\n\s*pub\s+fn|\n\s*})",src,re.S)
 if not m: raise SystemExit(f"missing public function: {name}")
 if old.get("source_bytes",0) and len(m.group(0).encode()) > old["source_bytes"]*(100+baseline["threshold_percent"])/100: raise SystemExit(f"{name} exceeds baseline")
print("resource baseline covers",len(baseline["functions"]),"public functions")
