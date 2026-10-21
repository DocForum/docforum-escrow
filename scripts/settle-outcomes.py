#!/usr/bin/env python3
"""Validate a human-approved outcome file and emit deterministic work items.
Submission is deliberately delegated to the integrator's signer/SDK.
"""
import argparse,json,sys
p=argparse.ArgumentParser(); p.add_argument("outcomes"); p.add_argument("--state",default="settlement-state.json"); a=p.parse_args()
d=json.load(open(a.outcomes)); rows=d.get("escrows",[])
if not rows: raise SystemExit("outcome file must contain escrows")
seen=set(); valid=[]
for row in rows:
 i=int(row["id"]); action=row["action"]
 if i in seen: raise SystemExit(f"duplicate escrow id: {i}")
 if action not in ("release","refund"): raise SystemExit(f"invalid action for {i}: {action}")
 seen.add(i); valid.append({"id":i,"action":action})
try: state=json.load(open(a.state))
except FileNotFoundError: state={"completed":[]}
done={int(x) for x in state.get("completed",[])}
for row in valid:
 if row["id"] not in done: print(json.dumps(row))
print(f"pending={sum(r["id"] not in done for r in valid)} completed={len(done)}",file=sys.stderr)
