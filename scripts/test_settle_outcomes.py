"""Offline tests for scripts/settle-outcomes.py (issue #94).

Run with: python3 -m unittest discover -s scripts -p 'test_*.py'

The submit command is a fake submitter written to a temp dir: it logs each
call and prints a fake transaction hash. Nothing touches a network or a key.
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
    if escrow_id == os.environ.get("KILL_ID"):
        os.kill(os.getppid(), signal.SIGKILL)  # the settle tool dies mid-run
        sys.exit(1)
    print("submitting...")
    print("tx" + escrow_id)
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
        self.cmd = " ".join(shlex.quote(x) for x in (sys.executable, fake)) + " {id} {action} " + shlex.quote(self.log)
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

    def calls(self):
        if not os.path.exists(self.log):
            return []
        with open(self.log) as f:
            return [int(line.split()[0]) for line in f]

    def state_records(self):
        with open(self.state) as f:
            return [json.loads(line) for line in f]

    def test_settles_all_and_records_tx_hashes(self):
        r = self.settle()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.calls(), [1, 2, 3, 4, 5])
        self.assertEqual(self.state_records()[0], {"id": 1, "action": "release", "tx": "tx1"})
        self.assertEqual([rec["tx"] for rec in self.state_records()], ["tx1", "tx2", "tx3", "tx4", "tx5"])

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

    def test_rejects_corrupt_state_file(self):
        with open(self.state, "w") as f:
            f.write('{"id": 1, "action": "release", "tx": "tx1"}\n{"id": 2, "act')
        r = self.settle()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("unreadable state line", r.stderr)
        self.assertEqual(self.calls(), [])


if __name__ == "__main__":
    unittest.main()
