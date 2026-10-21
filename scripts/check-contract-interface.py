#!/usr/bin/env python3
"""Deterministically snapshot the public Rust contract interface and error codes."""
import json,re,sys
from pathlib import Path
root=Path(__file__).resolve().parents[1]
src=(root/"contracts/escrow/src/lib.rs").read_text()
functions=[]
for m in re.finditer(r"pub\s+fn\s+([A-Za-z0-9_]+)\s*\((.*?)\)(?:\s*->\s*([^\{]+))?",src,re.S):
    args=' '.join(m.group(2).split())
    ret=' '.join((m.group(3) or '').split())
    functions.append({"name":m.group(1),"args":args,"return":ret})
errors=[]
block=re.search(r"pub enum Error\s*\{(.*?)\n\}",src,re.S)
if block:
 for line in block.group(1).splitlines():
  m=re.search(r"^\s*([A-Za-z0-9_]+)\s*=\s*(\d+)",line)
  if m: errors.append({"name":m.group(1),"code":int(m.group(2))})
out={"format":1,"functions":functions,"errors":errors}
print(json.dumps(out,indent=2)+"\n")
