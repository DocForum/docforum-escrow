import unittest

from check_github_action_pins import check_workflow


class CheckGitHubActionPinsTests(unittest.TestCase):
    def test_accepts_sha_pinned_action_with_version_comment(self):
        source = "jobs:\n  build:\n    steps:\n      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0\n"
        self.assertEqual(check_workflow(source, "valid.yml"), [])

    def test_rejects_floating_action_reference(self):
        source = "steps:\n  - uses: actions/checkout@v4\n"
        errors = check_workflow(source, "floating.yml")
        self.assertEqual(len(errors), 1)
        self.assertIn("floating.yml:2", errors[0])
        self.assertIn("full 40-character", errors[0])

    def test_rejects_invalid_or_incomplete_sha(self):
        source = "steps:\n  - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af67726 # v4.4.0\n"
        self.assertIn("40-character", check_workflow(source, "short-sha.yml")[0])

    def test_rejects_missing_version_comment(self):
        source = "steps:\n  - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262\n"
        self.assertIn("version comment", check_workflow(source, "no-comment.yml")[0])

    def test_allows_local_action(self):
        source = "steps:\n  - uses: ./action\n"
        self.assertEqual(check_workflow(source, "local.yml"), [])

    def test_checks_reusable_workflow_references(self):
        source = "jobs:\n  build:\n    uses: example/repo/.github/workflows/build.yml@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0\n"
        self.assertEqual(check_workflow(source, "reusable.yml"), [])

    def test_ignores_uses_text_inside_run_block(self):
        source = "steps:\n  - run: |\n      echo 'uses: actions/checkout@v4'\n"
        self.assertEqual(check_workflow(source, "script-text.yml"), [])


if __name__ == "__main__":
    unittest.main()
