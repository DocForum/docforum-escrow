#!/usr/bin/env python3
"""Settle escrows from a human-approved outcome file, resumably.

Used during a releaser-key compromise (docs/runbooks/releaser-compromise.md).
The outcome file says, per escrow id, whether to `release` or `refund`. This
tool never chooses an outcome: it validates the file, then runs the
integrator's own submit command once per escrow that is not settled yet.

The submit command is a template with `{id}` and `{action}` placeholders. It
is split like a shell command but run without a shell, and it holds the
signer, so no key ever passes through this tool. It must exit 0 only when the
transaction succeeded, and print the transaction hash as the last line of its
stdout. For example:

    stellar contract invoke --id C... --source releaser --network testnet \
      -- {action} --escrow_id {id} --caller G...

An optional status command (`--status-cmd`, template with `{id}`) prints the
escrow's current status, for example:

    stellar contract invoke --id C... --network testnet \
      -- get_status --escrow_id {id}

With a status command, an escrow that is no longer `Funded` is not submitted
again: someone else already settled it (the attacker, the timeout path, or
another operator). Without one, a submission that fails with `NotFunded`
(error #4) is still recorded as settled elsewhere, with the status unknown.

Every escrow is submitted in its own transaction, which is what keeps an
opted-in payee callback (`notify_payee`, a `release` only) from taking other
escrows down with it: the callback runs after the payout, so a failing one
reverts its whole invocation (issue #367, docs/adr/0012, threat model T11).
Keep it that way if you change the submit path — do not combine release ops
into one `settle_many` batch. Refund ops never invoke the callback, so only
release needs isolating.

Progress is kept in a state file of JSON lines, one per settled escrow:

    {"id": 12, "action": "release", "tx": "<hash>"}
    {"id": 13, "action": "refund", "settled_elsewhere": true, "status": "Refunded"}

The state file is rewritten atomically (temp file, fsync, rename) after every
successful submission or observed settlement, so a crash or kill at any point
leaves either the old or the new state, never a partial one. Re-running with
the same outcome file skips every id already in the state file and retries the
rest.

The final report separates escrows that settled as approved from those that
settled the other way (an incident signal: e.g. refunded when release was
approved) and from those that still failed. An escrow that settled the other
way or whose status could not be read still counts as settled, so a run that
only hit external settlements exits 0.

Standard library only; works on Python 3.9+.
"""
import argparse
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile

ACTIONS = ("release", "refund")
U64_MAX = 2**64 - 1
# `Error::NotFunded` is contract error 4: the escrow is not Funded any more,
# so a settlement already landed (our retry, the attacker, or the timeout).
NOT_FUNDED = re.compile(r"NotFunded|Error\(Contract, #4\)", re.IGNORECASE)
SOUGHT_STATUS = {"release": "Released", "refund": "Refunded"}
# `refund` returns the funds to the stored refund destination; `cancel` does the
# same (`Cancelled`), so both satisfy a refund outcome. Nothing satisfies a
# release outcome except `Released`.
EQUIVALENT = {"refund": ("Refunded", "Cancelled")}


def load_outcomes(path):
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    rows = data.get("escrows") if isinstance(data, dict) else None
    if not rows:
        raise SystemExit("outcome file must contain a non-empty \"escrows\" list")
    seen = set()
    outcomes = []
    for row in rows:
        if not isinstance(row, dict):
            raise SystemExit("each escrow entry must be an object: {}".format(row))
        escrow_id = row.get("id")
        action = row.get("action")
        if isinstance(escrow_id, bool) or not isinstance(escrow_id, int) or not 0 <= escrow_id <= U64_MAX:
            raise SystemExit("invalid escrow id: {!r}".format(escrow_id))
        if escrow_id in seen:
            raise SystemExit("duplicate escrow id: {}".format(escrow_id))
        if action not in ACTIONS:
            raise SystemExit("invalid action for {}: {!r}".format(escrow_id, action))
        seen.add(escrow_id)
        outcomes.append({"id": escrow_id, "action": action})
    return outcomes


def load_state(path):
    """Return {escrow_id: record} for every escrow already settled."""
    state = {}
    try:
        f = open(path, encoding="utf-8")
    except FileNotFoundError:
        return state
    with f:
        for lineno, line in enumerate(f, 1):
            if not line.strip():
                continue
            try:
                record = json.loads(line)
                escrow_id = record["id"]
                if not isinstance(escrow_id, int) or record["action"] not in ACTIONS:
                    raise ValueError
                if record.get("settled_elsewhere"):
                    if not isinstance(record.get("status"), str) or not record["status"]:
                        raise ValueError
                elif not record["tx"]:
                    raise ValueError
            except (ValueError, KeyError, TypeError):
                raise SystemExit("{}:{}: unreadable state line; fix or move the file".format(path, lineno))
            state[escrow_id] = record
    return state


def write_state(path, state):
    """Replace the state file atomically with one JSON line per settled id."""
    directory = os.path.dirname(os.path.abspath(path))
    fd, tmp = tempfile.mkstemp(prefix=".settle-state-", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            for escrow_id in sorted(state):
                f.write(json.dumps(state[escrow_id], sort_keys=True) + "\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise
    try:
        dir_fd = os.open(directory, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(dir_fd)
    except OSError:
        pass
    finally:
        os.close(dir_fd)


def run_template(template, values, timeout):
    """Run a command template without a shell. Return (last stdout line, error)."""
    argv = [part.replace("{id}", str(values["id"])).replace("{action}", values["action"])
            for part in shlex.split(template)]
    try:
        proc = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              universal_newlines=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return None, "timed out after {}s; the transaction may still land, check the status".format(timeout)
    except OSError as e:
        return None, "could not run command: {}".format(e)
    lines = [line.strip() for line in proc.stdout.splitlines() if line.strip()]
    if proc.returncode != 0:
        detail = (proc.stderr.strip().splitlines() or ["no stderr"])[-1]
        return None, "exit {}: {}".format(proc.returncode, detail)
    if not lines:
        return None, "command succeeded but printed nothing"
    return lines[-1].strip('"'), None


def read_status(template, escrow_id, timeout):
    """Ask the status command for one escrow. Return (status, None) or (None, error)."""
    status, error = run_template(template, {"id": escrow_id, "action": "status"}, timeout)
    if error:
        return None, error
    return normalize_status(status), None


def normalize_status(raw):
    """'Released' for RELEASED / \"released\" / Released; 'unknown' if empty."""
    text = (raw or "").strip().strip('"').strip()
    return text[:1].upper() + text[1:].lower() if text else "unknown"


def classify(status, action):
    """'intended', 'opposite', 'positive' (settled, status unknown), or 'open'.

    `open` means the escrow is still Funded and may be submitted. `positive`
    means it settled but the observed status does not say which way.
    """
    if status == "Funded":
        return "open"
    if status == "unknown":
        return "positive"
    if status == SOUGHT_STATUS[action] or status in EQUIVALENT.get(action, ()):
        return "intended"
    return "opposite"


def submit(template, row, timeout):
    """Run the submit command for one escrow. Return (tx_hash, None) or (None, error)."""
    return run_template(template, row, timeout)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("outcomes", help="human-approved outcome file (JSON)")
    p.add_argument("--submit-cmd", help="command template with {id} and {action}; "
                   "omit to only list the pending work")
    p.add_argument("--status-cmd", help="optional command template with {id} that prints "
                   "the escrow's current status; skips escrows that already settled")
    p.add_argument("--state", help="state file (default: <outcomes>.state.jsonl)")
    p.add_argument("--timeout", type=float, default=120,
                   help="seconds per status read or submission (default 120)")
    a = p.parse_args(argv)

    if a.submit_cmd and ("{id}" not in a.submit_cmd or "{action}" not in a.submit_cmd):
        raise SystemExit("--submit-cmd must contain both {id} and {action}")
    if a.status_cmd and "{id}" not in a.status_cmd:
        raise SystemExit("--status-cmd must contain {id}")
    outcomes = load_outcomes(a.outcomes)
    state_path = a.state or a.outcomes + ".state.jsonl"
    state = load_state(state_path)

    wanted = {row["id"]: row["action"] for row in outcomes}
    for escrow_id, record in state.items():
        if escrow_id in wanted and record["action"] != wanted[escrow_id]:
            raise SystemExit("escrow {} was already settled as {} (tx {}) but the outcome file now says {}".format(
                escrow_id, record["action"], record.get("tx", record.get("status", "unknown")), wanted[escrow_id]))
    extra = sorted(set(state) - set(wanted))
    if extra:
        print("warning: state file has ids not in the outcome file: {}".format(extra), file=sys.stderr)

    pending = [row for row in outcomes if row["id"] not in state]
    print("state={} pending={} completed={}".format(state_path, len(pending), len(outcomes) - len(pending)),
          file=sys.stderr)

    if not a.submit_cmd:
        for row in pending:
            print(json.dumps(row))
        return 0

    failed = []
    for row in pending:
        escrow_id = row["id"]
        if a.status_cmd:
            status, error = read_status(a.status_cmd, escrow_id, a.timeout)
            if error:
                failed.append(escrow_id)
                print("FAILED {} {}: could not read status ({}); not submitted".format(
                    row["action"], escrow_id, error), file=sys.stderr)
                continue
            if classify(status, row["action"]) != "open":
                state[escrow_id] = {"id": escrow_id, "action": row["action"],
                                    "settled_elsewhere": True, "status": status}
                write_state(state_path, state)
                print("already settled {} {} status={} (not submitted)".format(
                    row["action"], escrow_id, status))
                continue
        tx, error = submit(a.submit_cmd, row, a.timeout)
        if error:
            if NOT_FUNDED.search(error):
                status = "unknown"
                if a.status_cmd:
                    observed, status_error = read_status(a.status_cmd, escrow_id, a.timeout)
                    status = observed if observed is not None else "unknown"
                    if status_error:
                        print("warning: could not read status for {}: {}".format(escrow_id, status_error),
                              file=sys.stderr)
                    elif classify(status, row["action"]) == "open":
                        # NotFunded but still Funded: the submission landed in a
                        # way the status read cannot see yet. Never retry blindly.
                        status = "unknown"
                state[escrow_id] = {"id": escrow_id, "action": row["action"],
                                    "settled_elsewhere": True, "status": status}
                write_state(state_path, state)
                print("already settled {} {} status={} ({})".format(
                    row["action"], escrow_id, status, error))
                continue
            failed.append(escrow_id)
            print("FAILED {} {}: {}".format(row["action"], escrow_id, error), file=sys.stderr)
            continue
        state[escrow_id] = {"id": escrow_id, "action": row["action"], "tx": tx}
        write_state(state_path, state)
        print("settled {} {} tx={}".format(row["action"], escrow_id, tx))

    intended = opposite = unknown = 0
    incidents = []
    for escrow_id, record in sorted(state.items()):
        if escrow_id not in wanted:
            continue
        status = record.get("status")
        kind = classify(status, record["action"]) if status else "intended"
        if kind == "intended":
            intended += 1
        elif kind == "opposite":
            opposite += 1
            incidents.append(record)
        else:
            unknown += 1

    print("done: settled_as_approved={} settled_otherwise={} settled_status_unknown={} failed={} total={}".format(
        intended, opposite, unknown, len(failed), len(outcomes)), file=sys.stderr)
    if incidents:
        print("INCIDENT: {} escrow(s) settled the opposite way from the approved outcome:".format(
            len(incidents)), file=sys.stderr)
        for record in incidents:
            print("  escrow {}: approved {} but observed {} (settled elsewhere)".format(
                record["id"], record["action"], record["status"]), file=sys.stderr)
    if failed:
        print("re-run the same command to retry: {}".format(failed), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
