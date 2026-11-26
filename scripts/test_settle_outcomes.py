"""Offline tests for scripts/settle-outcomes.py (issue #94, extended in #354).

Run with: python3 -m unittest discover -s scripts -p 'test_*.py'

The submit and status commands are fakes written to a temp dir: they log each
call and print a fake transaction hash or status. Nothing touches a network or
a key.
"""
import json
import os
import shlex
import subprocess
import sys
import tempfile
import textwrap
import unittest

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "settle-outcomes.py")

FAKE_SUBMITTER = textwrap.dedent("""
    import os, signal, sys
    escrow_id, action, log = sys.argv[1], sys.argv[2], sys.argv[3]
    with open(log, "a") as f:
        f.write(escrow_id + " " + action + "\\n")
    if escrow_id == os.environ.get("FAIL_ID"):
        print("rate limited", file=sys.stderr)
        sys.exit(1)
    if escrow_id == os.environ.get("NOT_FUNDED_ID"):
        print("Error(Contract, #4)", file=sys.stderr)
        sys.exit(1)
    if escrow_id == os.environ.get("KILL_ID"):
        os.kill(os.getppid(), signal.SIGKILL)  # the settle tool dies mid-run
        sys.exit(1)
    print("submitting...")
    print("tx" + escrow_id)
""")

FAKE_STATUS = textwrap.dedent("""
    import os, sys
    escrow_id = sys.argv[1]
    with open(sys.argv[2], "a") as f:
        f.write("status " + escrow_id + "\\n")
    if escrow_id == os.environ.get("STATUS_FAIL_ID"):
        print("rpc unavailable", file=sys.stderr)
        sys.exit(1)
    print(os.environ.get("STATUS_" + escrow_id, "Funded"))
""")


class SettleOutcomesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name
        self.outcomes = os.path.join(self.dir, "outcomes.json")
        self.state = self.outcomes + ".state.jsonl"
        self.log = os.path.join(self.dir, "calls.log")
        fake = os.path.join(self.dir, "fake_submit.py")
        with open(fake, "w") as f:
            f.write(FAKE_SUBMITTER)
        fake_status = os.path.join(self.dir, "fake_status.py")
        with open(fake_status, "w") as f:
            f.write(FAKE_STATUS)
        self.cmd = " ".join(shlex.quote(x) for x in (sys.executable, fake)) + " {id} {action} " + shlex.quote(self.log)
        self.status_cmd = " ".join(shlex.quote(x) for x in (sys.executable, fake_status)) + " {id} " + shlex.quote(self.log)
        self.write_outcomes([{"id": i, "action": "release" if i % 2 else "refund"} for i in range(1, 6)])

    def tearDown(self):
        self.tmp.cleanup()

    def write_outcomes(self, rows):
        with open(self.outcomes, "w") as f:
            json.dump({"escrows": rows}, f)

    def run_tool(self, *extra, **env):
        return subprocess.run([sys.executable, SCRIPT, self.outcomes, *extra],
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True,
                              env=dict(os.environ, **env))

    def settle(self, **env):
        return self.run_tool("--submit-cmd", self.cmd, **env)

    def settle_with_status(self, **env):
        return self.run_tool("--submit-cmd", self.cmd, "--status-cmd", self.status_cmd, **env)

    def log_lines(self):
        if not os.path.exists(self.log):
            return []
        with open(self.log) as f:
            return [line.split() for line in f]

    def calls(self, action=None):
        return [int(parts[0]) for parts in self.log_lines()
                if parts[0].isdigit() and (action is None or parts[1] == action)]

    def submit_calls(self):
        return [(int(parts[0]), parts[1]) for parts in self.log_lines() if parts[0].isdigit()]

    def status_calls(self):
        return [int(parts[1]) for parts in self.log_lines() if parts[0] == "status"]

    def state_records(self):
        with open(self.state) as f:
            return [json.loads(line) for line in f]

    def test_settles_all_and_records_tx_hashes(self):
        r = self.settle()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.calls(), [1, 2, 3, 4, 5])
        self.assertEqual(self.state_records()[0], {"id": 1, "action": "release", "tx": "tx1"})
        self.assertEqual([rec["tx"] for rec in self.state_records()], ["tx1", "tx2", "tx3", "tx4", "tx5"])
        self.assertIn("settled_as_approved=5", r.stderr)

    def test_rerun_skips_settled_ids(self):
        self.settle()
        r = self.settle()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.calls(), [1, 2, 3, 4, 5])
        self.assertIn("pending=0 completed=5", r.stderr)

    def test_failed_submission_is_retried_on_rerun(self):
        r = self.settle(FAIL_ID="3")
        self.assertEqual(r.returncode, 1)
        self.assertIn("FAILED release 3", r.stderr)
        self.assertEqual([rec["id"] for rec in self.state_records()], [1, 2, 4, 5])
        r = self.settle()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.calls(), [1, 2, 3, 4, 5, 3])
        self.assertEqual([rec["id"] for rec in self.state_records()], [1, 2, 3, 4, 5])

    def test_resumes_after_crash_mid_run(self):
        r = self.settle(KILL_ID="4")
        self.assertEqual(r.returncode, -9)
        self.assertEqual([rec["id"] for rec in self.state_records()], [1, 2, 3])
        self.assertEqual([n for n in os.listdir(self.dir) if n.startswith(".settle-state-")], [])
        r = self.settle()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.calls(), [1, 2, 3, 4, 4, 5])
        self.assertEqual([rec["tx"] for rec in self.state_records()], ["tx1", "tx2", "tx3", "tx4", "tx5"])

    def test_list_mode_prints_pending_without_submitting(self):
        self.settle(FAIL_ID="2")
        r = self.run_tool()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual([json.loads(line) for line in r.stdout.splitlines()], [{"id": 2, "action": "refund"}])
        self.assertEqual(self.calls(), [1, 2, 3, 4, 5])

    def test_refuses_outcome_that_contradicts_state(self):
        self.settle()
        self.write_outcomes([{"id": 1, "action": "refund"}])
        r = self.settle()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("already settled as release", r.stderr)

    def test_rejects_invalid_outcome_files(self):
        for rows in ([], [{"id": 1, "action": "steal"}], [{"id": 1, "action": "refund"}] * 2,
                     [{"id": "1", "action": "refund"}], [{"id": -1, "action": "refund"}]):
            self.write_outcomes(rows)
            r = self.settle()
            self.assertNotEqual(r.returncode, 0, rows)
        self.assertEqual(self.calls(), [])

    def test_rejects_submit_cmd_without_placeholders(self):
        r = self.run_tool("--submit-cmd", self.cmd.replace("{id}", "1"))
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("must contain both {id} and {action}", r.stderr)
        self.assertEqual(self.calls(), [])

    def test_rejects_status_cmd_without_placeholder(self):
        r = self.run_tool("--submit-cmd", self.cmd, "--status-cmd", self.status_cmd.replace("{id}", "1"))
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("--status-cmd must contain {id}", r.stderr)
        self.assertEqual(self.calls(), [])

    def test_rejects_corrupt_state_file(self):
        with open(self.state, "w") as f:
            f.write('{"id": 1, "action": "release", "tx": "tx1"}\n{"id": 2, "act')
        r = self.settle()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("unreadable state line", r.stderr)
        self.assertEqual(self.calls(), [])

    # Issue #354: escrows settled elsewhere.
    def test_status_cmd_skips_escrows_that_already_settled(self):
        r = self.settle_with_status(STATUS_2="Refunded")
        self.assertEqual(r.returncode, 0, r.stderr)
        # 2 was already refunded, so only the others were submitted.
        self.assertEqual(self.calls(), [1, 3, 4, 5])
        self.assertEqual(self.status_calls(), [1, 2, 3, 4, 5])
        record = next(rec for rec in self.state_records() if rec["id"] == 2)
        self.assertEqual(record, {"action": "refund", "id": 2, "settled_elsewhere": True, "status": "Refunded"})
        self.assertIn("settled_as_approved=5", r.stderr)
        self.assertIn("settled_otherwise=0", r.stderr)

    def test_rerun_after_external_settlement_exits_zero(self):
        self.settle_with_status(STATUS_2="Refunded")
        calls = self.calls("release")
        r = self.settle_with_status()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.calls("release"), calls)
        self.assertIn("pending=0 completed=5", r.stderr)
        self.assertEqual(len(self.state_records()), 5)

    def test_opposite_settlement_is_reported_as_an_incident(self):
        # 4 was approved for refund, but it settled as a release.
        r = self.settle_with_status(STATUS_4="Released")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertNotIn(4, self.calls("release"))
        self.assertIn("INCIDENT: 1 escrow(s)", r.stderr)
        self.assertIn("escrow 4: approved refund but observed Released", r.stderr)
        self.assertIn("settled_as_approved=4", r.stderr)
        self.assertIn("settled_otherwise=1", r.stderr)

    def test_cancelled_counts_as_a_refund(self):
        # Cancel returns the funds to the refund destination, like refund.
        r = self.settle_with_status(STATUS_2="Cancelled")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertNotIn(2, self.calls("release"))
        self.assertIn("settled_otherwise=0", r.stderr)
        self.assertNotIn("INCIDENT", r.stderr)

    def test_not_funded_failure_is_recorded_as_settled_elsewhere(self):
        r = self.settle_with_status(NOT_FUNDED_ID="3", STATUS_3="Released")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("already settled release 3 status=Released", r.stdout)
        self.assertNotIn("FAILED", r.stderr)
        self.assertIn("settled_as_approved=5", r.stderr)
        self.assertIn("failed=0", r.stderr)
        record = next(rec for rec in self.state_records() if rec["id"] == 3)
        self.assertEqual(record["status"], "Released")
        self.assertTrue(record["settled_elsewhere"])

    def test_not_funded_without_status_cmd_is_settled_status_unknown(self):
        r = self.settle(NOT_FUNDED_ID="3")
        self.assertEqual(r.returncode, 0, r.stderr)
        record = next(rec for rec in self.state_records() if rec["id"] == 3)
        self.assertEqual(record["status"], "unknown")
        self.assertIn("settled_status_unknown=1", r.stderr)
        self.assertIn("failed=0", r.stderr)

    def test_other_submission_failures_still_fail(self):
        r = self.settle_with_status(FAIL_ID="3")
        self.assertEqual(r.returncode, 1)
        self.assertIn("FAILED release 3", r.stderr)
        self.assertNotIn(3, [rec["id"] for rec in self.state_records()])

    def test_status_read_failure_is_not_submitted_and_fails_the_run(self):
        r = self.settle_with_status(STATUS_FAIL_ID="2")
        self.assertEqual(r.returncode, 1)
        self.assertNotIn(2, self.calls("release"))
        self.assertIn("could not read status", r.stderr)

    def test_status_cmd_does_not_choose_an_outcome(self):
        # Every status reads Funded, so each outcome is submitted exactly as approved.
        r = self.settle_with_status()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(
            self.submit_calls(),
            [(1, "release"), (2, "refund"), (3, "release"), (4, "refund"), (5, "release")],
        )


if __name__ == "__main__":
    unittest.main()
