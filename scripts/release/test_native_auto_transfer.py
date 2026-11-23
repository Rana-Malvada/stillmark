"""Automatic cache discovery preserves trust, source binding and cold-build fallback."""
import json
import os
import pathlib
import subprocess
import shutil
import tempfile
import unittest
from unittest.mock import patch
import native_cache_transfer as transfer


class NativeAutomaticTransferTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temp.name)
        self.binding = patch.object(transfer, "ROOT", self.root)
        self.binding.start()
        self.run = {
            "id": 42, "head_sha": "a" * 40, "event": "push", "head_branch": "main",
            "status": "completed", "conclusion": "success",
            "path": "docs/reference/github-quality-workflow.yml",
            "repository": {"full_name": "owner/repo"},
            "head_repository": {"full_name": "owner/repo"},
        }

    def tearDown(self):
        self.binding.stop()
        self.temp.cleanup()

    def select(self, runs, *, ancestors=None, compatible=None, imports=None):
        with patch.object(transfer, "repository_info", return_value=("owner/repo", "main")), \
             patch.object(transfer, "command", return_value=json.dumps({"workflow_runs": runs})), \
             patch.object(transfer, "is_ancestor", side_effect=ancestors or (lambda _: True)) as ancestry, \
             patch.object(transfer, "compatible_inputs", side_effect=compatible or (lambda _: True)) as inputs, \
             patch.object(transfer, "import_run", side_effect=imports or (lambda *a, **k: True)) as importer:
            result = transfer.restore_latest()
            return result, ancestry, inputs, importer

    def test_latest_compatible_ancestor_selected(self):
        newer = {**self.run, "id": 43, "head_sha": "b" * 40}
        result, _, _, importer = self.select([newer, self.run], compatible=[False, True])
        self.assertEqual(result["runId"], 42)
        importer.assert_called_once_with(42, "a" * 40, allow_missing=True, repository="owner/repo")
        self.assertEqual(json.loads((self.root / ".release/native-cache-import/selection.json").read_text()), result)

    def test_missing_expired_and_no_compatible_cache_are_normal_cold_build(self):
        for runs, imports in [([], None), ([self.run], [False])]:
            result, *_ = self.select(runs, imports=imports)
            self.assertTrue(result["coldBuild"])
            self.assertFalse(result["imported"])

    def test_missing_newest_artifact_can_use_older_compatible_run(self):
        result, _, _, importer = self.select([{**self.run, "id": 43}, self.run], imports=[False, True])
        self.assertEqual(result["runId"], 42)
        self.assertEqual(importer.call_count, 2)

    def test_nonancestor_skipped_before_artifact_download(self):
        result, _, inputs, importer = self.select([self.run], ancestors=[False])
        self.assertTrue(result["coldBuild"])
        inputs.assert_not_called()
        importer.assert_not_called()

    def test_failed_inprogress_pr_and_nondefault_runs_never_used(self):
        for delta in [{"conclusion": "failure"}, {"status": "in_progress"},
                      {"event": "pull_request"}, {"head_branch": "other"}]:
            with self.subTest(delta=delta):
                result, ancestry, _, importer = self.select([{**self.run, **delta}])
                self.assertTrue(result["coldBuild"])
                ancestry.assert_not_called()
                importer.assert_not_called()

    def test_default_branch_workflow_dispatch_is_accepted(self):
        result, *_ = self.select([{**self.run, "event": "workflow_dispatch"}])
        self.assertTrue(result["imported"])

    def test_untrusted_run_or_tampered_artifact_fails_closed(self):
        for delta in [{"repository": {"full_name": "other/repo"}},
                      {"head_repository": {"full_name": "fork/repo"}},
                      {"path": ".github/workflows/untrusted.yml"}, {"id": True}]:
            with self.subTest(delta=delta), self.assertRaises(ValueError):
                self.select([{**self.run, **delta}])
        with self.assertRaisesRegex(ValueError, "tampered"):
            self.select([self.run], imports=ValueError("tampered archive"))
        with self.assertRaises(subprocess.CalledProcessError):
            self.select([self.run], imports=subprocess.CalledProcessError(1, "gh"))

    def test_artifact_expiry_is_miss_duplicate_is_error(self):
        artifact = {"name": "video-native-cache-" + "a" * 40, "expired": False}
        for rows in [[], [{**artifact, "expired": True}]]:
            with patch.object(transfer, "command", return_value=json.dumps({"artifacts": rows})):
                self.assertIsNone(transfer.available_artifact("owner/repo", 42, "a" * 40))
        with patch.object(transfer, "command", return_value=json.dumps({"artifacts": [artifact, artifact]})), \
             self.assertRaisesRegex(ValueError, "Ambiguous"):
            transfer.available_artifact("owner/repo", 42, "a" * 40)

    def test_import_missing_cache_never_seeds_docker(self):
        responses = ["a" * 40, json.dumps(self.run), json.dumps({"artifacts": []})]
        with patch.object(transfer, "command", side_effect=responses), \
             patch.object(transfer.subprocess, "run") as runner:
            self.assertFalse(transfer.import_run(42, "a" * 40, allow_missing=True, repository="owner/repo"))
            self.assertEqual(runner.call_count, 1)
            self.assertEqual(runner.call_args.args[0][:3], ["git", "merge-base", "--is-ancestor"])

    def test_expiry_during_download_is_miss_but_other_failures_block(self):
        artifact = {"name": "video-native-cache-" + "a" * 40, "expired": False}
        responses = ["a" * 40, json.dumps(self.run)]
        for refresh, missing in [(None, True), (artifact, False)]:
            with self.subTest(missing=missing), \
                 patch.object(transfer, "command", side_effect=responses), \
                 patch.object(transfer, "available_artifact", side_effect=[artifact, refresh]), \
                 patch.object(transfer.subprocess, "run", side_effect=[subprocess.CompletedProcess("git", 0), subprocess.CompletedProcess("gh", 1)]) as runner:
                if missing:
                    self.assertFalse(transfer.import_run(42, "a" * 40, allow_missing=True, repository="owner/repo"))
                else:
                    with self.assertRaises(subprocess.CalledProcessError):
                        transfer.import_run(42, "a" * 40, allow_missing=True, repository="owner/repo")
                self.assertEqual(runner.call_count, 2)

    def test_real_export_validation_precedes_docker_seed(self):
        from test_native_transfer import NativeTransferTests
        for tamper in (False, True):
            fixture = NativeTransferTests()
            fixture.setUp()
            try:
                if tamper:
                    (fixture.entry / "runtime.tar.gz").write_bytes(b"tampered")
                commands = []
                def run(args, **kwargs):
                    commands.append(args)
                    if args[:3] == ["gh", "run", "download"]:
                        shutil.copytree(fixture.export, pathlib.Path(args[-1]), dirs_exist_ok=True)
                    return subprocess.CompletedProcess(args, 0)
                artifact = {"id": 1, "name": "video-native-cache-" + "a" * 40, "expired": False}
                responses = ["a" * 40, json.dumps({**self.run, "id": 42})]
                with self.subTest(tamper=tamper), \
                     patch.object(transfer, "command", side_effect=responses), \
                     patch.object(transfer, "available_artifact", return_value=artifact), \
                     patch.object(transfer.subprocess, "run", side_effect=run):
                    if tamper:
                        with self.assertRaisesRegex(ValueError, "digest mismatch"):
                            transfer.import_run(42, "a" * 40, allow_missing=True, repository="owner/repo")
                    else:
                        self.assertTrue(transfer.import_run(42, "a" * 40, allow_missing=True, repository="owner/repo"))
                self.assertEqual(any(c[0] == "docker" for c in commands), not tamper)
            finally:
                fixture.tearDown()

    def test_workflow_restores_before_checks_with_read_only_step_token(self):
        workflow = pathlib.Path(__file__).resolve().parents[2] / "docs/reference/github-quality-workflow.yml"
        text = workflow.read_text()
        self.assertLess(text.index("--restore-latest"), text.index("python3 scripts/release/check.py"))
        self.assertIn("actions: read", text)
        self.assertNotIn("actions: write", text)
        self.assertEqual(text.count("GH_TOKEN:"), 1)
        self.assertIn("retention-days: 90", text)
        self.assertIn("timeout-minutes: 15", text)

    def test_authenticated_repository_mismatch_is_error(self):
        with patch.dict(transfer.os.environ, {"GITHUB_REPOSITORY": "owner/repo"}), \
             patch.object(transfer, "command", return_value=json.dumps({"full_name": "other/repo", "default_branch": "main"})), \
             self.assertRaisesRegex(ValueError, "identity mismatch"):
            transfer.repository_info()


class NativeSourceCompatibilityTests(unittest.TestCase):
    def setUp(self):
        # Git fixture setup and production helper probes must never inherit a
        # caller's repository, index, worktree, config or object-directory overrides.
        isolated = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
        environment = patch.dict(os.environ, isolated, clear=True)
        environment.start()
        self.addCleanup(environment.stop)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.native = self.root / "workers/video-gpu/native"
        self.native.mkdir(parents=True)
        self.recipe = self.native.parent / "Dockerfile"
        self.recipe.write_text("FROM immutable-base\nRUN native-build\n")
        (self.native / "build-inputs.json").write_text(json.dumps({"files": ["build-inputs.json", "patch"]}))
        (self.native / "patch").write_text("native patch")
        (self.root / "app.ts").write_text("app one")
        self.git("init", "-q")
        self.git("config", "user.email", "fixture@example.invalid")
        self.git("config", "user.name", "Fixture")
        self.commit("base")
        self.original = self.git("rev-parse", "HEAD")
        self.patches = [patch.object(transfer, "ROOT", self.root), patch.object(transfer, "NATIVE", self.native), patch.object(transfer, "RECIPE", self.recipe)]
        for binding in self.patches:
            binding.start()
            self.addCleanup(binding.stop)

    def git(self, *args):
        environment = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
        return subprocess.check_output(
            ["git", *args], cwd=self.root, env=environment,
            text=True, stderr=subprocess.DEVNULL,
        ).strip()

    def test_inherited_git_overrides_cannot_mutate_sentinel_repository(self):
        with tempfile.TemporaryDirectory() as directory:
            sentinel = pathlib.Path(directory)
            environment = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
            def sentinel_git(*args):
                return subprocess.check_output(
                    ["git", *args], cwd=sentinel, env=environment,
                    text=True, stderr=subprocess.DEVNULL,
                ).strip()
            sentinel_git("init", "-q")
            sentinel_git("config", "user.email", "sentinel@example.invalid")
            sentinel_git("config", "user.name", "Sentinel")
            (sentinel / "protected.txt").write_text("Do not change")
            sentinel_git("add", ".")
            sentinel_git("commit", "-qm", "sentinel")
            before_head = sentinel_git("rev-parse", "HEAD")
            before_files = {name: (sentinel / ".git" / name).read_bytes()
                            for name in ("HEAD", "index", "config")}
            before_cwd = pathlib.Path.cwd()
            hostile = {
                "GIT_DIR": str(sentinel / ".git"), "GIT_WORK_TREE": str(sentinel),
                "GIT_INDEX_FILE": str(sentinel / ".git/index"),
                "GIT_COMMON_DIR": str(sentinel / ".git"),
                "GIT_OBJECT_DIRECTORY": str(sentinel / ".git/objects"),
                "GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "user.name",
                "GIT_CONFIG_VALUE_0": "Wrong author",
            }
            with patch.dict(os.environ, hostile):
                self.git("init", "-q")
                self.git("config", "user.name", "Fixture isolated")
                (self.root / "app.ts").write_text("isolated fixture edit")
                self.commit("isolated fixture only")
                self.assertEqual(self.git("rev-parse", "--show-toplevel"), str(self.root.resolve()))
                self.assertEqual(self.git("log", "-1", "--format=%an"), "Fixture isolated")
            self.assertEqual(sentinel_git("rev-parse", "HEAD"), before_head)
            self.assertEqual(sentinel_git("status", "--porcelain"), "")
            self.assertEqual(pathlib.Path.cwd(), before_cwd)
            self.assertEqual((sentinel / "protected.txt").read_text(), "Do not change")
            for name, before in before_files.items():
                self.assertEqual((sentinel / ".git" / name).read_bytes(), before, name)

    def commit(self, message):
        self.git("add", ".")
        self.git("commit", "-qm", message)

    def test_application_only_change_reuses_native_build(self):
        (self.root / "app.ts").write_text("app two")
        self.commit("application only")
        self.assertTrue(transfer.is_ancestor(self.original))
        self.assertTrue(transfer.compatible_inputs(self.original))

    def test_patch_base_recipe_or_input_inventory_change_invalidates_cache(self):
        for path in [self.native / "patch", self.recipe, self.native / "build-inputs.json"]:
            old = path.read_bytes()
            path.write_bytes(old + b"\n")
            self.commit("native input change")
            self.assertFalse(transfer.compatible_inputs(self.original))
            path.write_bytes(old)
            self.commit("restore")

    def test_nonancestor_and_missing_commit_are_not_cache_sources(self):
        self.git("checkout", "--orphan", "unrelated")
        self.commit("unrelated history")
        self.assertFalse(transfer.is_ancestor(self.original))
        self.assertFalse(transfer.is_ancestor("f" * 40))
        with self.assertRaisesRegex(ValueError, "Invalid cache source"):
            transfer.is_ancestor("HEAD;unsafe")


if __name__ == "__main__":
    unittest.main()
