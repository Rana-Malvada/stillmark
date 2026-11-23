import unittest

import ci_evidence

HEAD, PR_HEAD, TREE = "a" * 40, "b" * 40, "t" * 40


def run(name, conclusion="success", app="github-actions", run_id=1):
    return {"name": name, "conclusion": conclusion, "id": run_id, "app": {"slug": app}}


class Evidence(unittest.TestCase):
    def ask(self, *, status="", pulls=None, trees=None, checks=None, fail=False):
        trees = trees or {HEAD: TREE, PR_HEAD: TREE}
        checks = checks or {}
        pulls = [{"head": {"sha": PR_HEAD}, "merged_at": "2026-11-23T00:00:00Z"}] if pulls is None else pulls

        def git(*args):
            return {"status": status, "rev-parse": HEAD if args[-1] == "HEAD" else TREE}[args[0]]

        def api(path):
            if fail:
                raise OSError("offline")
            if path.startswith("git/commits/"):
                return {"tree": {"sha": trees[path.split("/")[-1]]}}
            if path.endswith("/pulls"):
                return pulls
            return {"check_runs": checks.get(path.split("/")[1], [])}

        return ci_evidence.verified(git=git, api=api)

    both = [run(name) for name in ci_evidence.REQUIRED]

    def test_squash_merge_is_matched_to_the_pull_request_commit_with_the_same_files(self):
        ok, where = self.ask(checks={PR_HEAD: self.both})
        self.assertTrue(ok)
        self.assertIn(PR_HEAD[:7], where)

    def test_a_pass_on_the_commit_itself_counts(self):
        self.assertTrue(self.ask(pulls=[], checks={HEAD: self.both})[0])

    def test_local_changes_are_never_covered(self):
        ok, why = self.ask(status=" M lib/x.ts", checks={PR_HEAD: self.both})
        self.assertFalse(ok)
        self.assertIn("changes", why)

    def test_different_files_are_never_covered(self):
        # The pull request was merged while behind main: its checks saw other files.
        self.assertFalse(self.ask(trees={HEAD: TREE, PR_HEAD: "x" * 40}, checks={PR_HEAD: self.both})[0])

    def test_both_checks_must_have_passed(self):
        self.assertFalse(self.ask(checks={PR_HEAD: self.both[:1]})[0])
        failed = [self.both[0], run(ci_evidence.REQUIRED[1], "failure")]
        self.assertFalse(self.ask(checks={PR_HEAD: failed})[0])

    def test_the_latest_run_of_a_check_decides(self):
        name = ci_evidence.REQUIRED[1]
        rerun_failed = [self.both[0], run(name, "success", run_id=1), run(name, "failure", run_id=2)]
        self.assertFalse(self.ask(checks={PR_HEAD: rerun_failed})[0])
        rerun_passed = [self.both[0], run(name, "failure", run_id=1), run(name, "success", run_id=2)]
        self.assertTrue(self.ask(checks={PR_HEAD: rerun_passed})[0])

    def test_only_githubs_own_runner_is_believed(self):
        forged = [run(name, app="some-other-app") for name in ci_evidence.REQUIRED]
        self.assertFalse(self.ask(checks={PR_HEAD: forged})[0])

    def test_an_unmerged_pull_request_is_ignored(self):
        open_pull = [{"head": {"sha": PR_HEAD}, "merged_at": None}]
        self.assertFalse(self.ask(pulls=open_pull, checks={PR_HEAD: self.both})[0])

    def test_no_answer_means_not_verified(self):
        ok, why = self.ask(fail=True)
        self.assertFalse(ok)
        self.assertIn("could not be asked", why)


if __name__ == "__main__":
    unittest.main()
