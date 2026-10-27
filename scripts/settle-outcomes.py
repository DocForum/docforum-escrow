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

Progress is kept in a state file of JSON lines, one per settled escrow:

    {"id": 12, "action": "release", "tx": "<hash>"}

The state file is rewritten atomically (temp file, fsync, rename) after every
successful submission, so a crash or kill at any point leaves either the old
or the new state, never a partial one. Re-running with the same outcome file
skips every id already in the state file and retries the rest.

Standard library only; works on Python 3.9+.
"""
import argparse
import json
import os
import shlex
import subprocess
import sys
import tempfile

ACTIONS = ("release", "refund")
U64_MAX = 2**64 - 1


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
                if not isinstance(escrow_id, int) or record["action"] not in ACTIONS or not record["tx"]:
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


def submit(template, row, timeout):
    """Run the submit command for one escrow. Return (tx_hash, None) or (None, error)."""
    argv = [part.replace("{id}", str(row["id"])).replace("{action}", row["action"])
            for part in shlex.split(template)]
    try:
        proc = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              universal_newlines=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return None, "timed out after {}s; the transaction may still land, check get_status".format(timeout)
    except OSError as e:
        return None, "could not run submit command: {}".format(e)
    lines = [line.strip() for line in proc.stdout.splitlines() if line.strip()]
    if proc.returncode != 0:
        detail = (proc.stderr.strip().splitlines() or ["no stderr"])[-1]
        return None, "exit {}: {}".format(proc.returncode, detail)
    if not lines:
        return None, "submit command succeeded but printed no transaction hash"
    return lines[-1].strip('"'), None


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("outcomes", help="human-approved outcome file (JSON)")
    p.add_argument("--submit-cmd", help="command template with {id} and {action}; "
                   "omit to only list the pending work")
    p.add_argument("--state", help="state file (default: <outcomes>.state.jsonl)")
    p.add_argument("--timeout", type=float, default=120, help="seconds per submission (default 120)")
    a = p.parse_args(argv)

    if a.submit_cmd and ("{id}" not in a.submit_cmd or "{action}" not in a.submit_cmd):
        raise SystemExit("--submit-cmd must contain both {id} and {action}")
    outcomes = load_outcomes(a.outcomes)
    state_path = a.state or a.outcomes + ".state.jsonl"
    state = load_state(state_path)

    wanted = {row["id"]: row["action"] for row in outcomes}
    for escrow_id, record in state.items():
        if escrow_id in wanted and record["action"] != wanted[escrow_id]:
            raise SystemExit("escrow {} was already settled as {} (tx {}) but the outcome file now says {}".format(
                escrow_id, record["action"], record["tx"], wanted[escrow_id]))
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
        tx, error = submit(a.submit_cmd, row, a.timeout)
        if error:
            failed.append(row["id"])
            print("FAILED {} {}: {}".format(row["action"], row["id"], error), file=sys.stderr)
            continue
        state[row["id"]] = {"id": row["id"], "action": row["action"], "tx": tx}
        write_state(state_path, state)
        print("settled {} {} tx={}".format(row["action"], row["id"], tx))

    print("done: settled={} failed={} total={}".format(len(pending) - len(failed), len(failed), len(outcomes)),
          file=sys.stderr)
    if failed:
        print("re-run the same command to retry: {}".format(failed), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
