"""Prove stale local bundles/dependencies cannot enter video worker builds."""

import hashlib
import json
import pathlib
import re
import shutil
import subprocess
import tempfile
import unittest
from video_image import SOURCE_FILES, prepare_context

ROOT = pathlib.Path(__file__).resolve().parents[2]


class VideoImageSource(unittest.TestCase):
    def test_exact_committed_inputs_exclude_dirty_source_and_host_artifacts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            repo = root / "repo"
            repo.mkdir()

            def git(*args):
                return subprocess.run(
                    ["git", *args], cwd=repo, check=True, capture_output=True, text=True
                ).stdout.strip()

            git("init")
            git("config", "user.name", "Release fixture")
            git("config", "user.email", "release@example.invalid")
            for name in SOURCE_FILES:
                path = repo / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("committed\n")
            git("add", ".")
            git("commit", "-m", "fixture")
            commit = git("rev-parse", "HEAD")
            (repo / "workers/video-gpu/worker.ts").write_text("uncommitted\n")
            for name in [
                "workers/video-gpu/dist/worker.mjs",
                "workers/video-gpu/node_modules/private",
                ".env.local",
                "lib/postgres.ts",
            ]:
                path = repo / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("must not ship")
            context = root / "context"
            self.assertEqual(prepare_context(repo, commit, context), commit)
            self.assertEqual(
                {str(p.relative_to(context)) for p in context.rglob("*") if p.is_file()},
                set(SOURCE_FILES),
            )
            self.assertEqual((context / "workers/video-gpu/worker.ts").read_text(), "committed\n")

    def test_current_native_recipe_and_relative_imports_fit_build_boundary(self):
        allowed = set(SOURCE_FILES)
        for path in (ROOT / "workers/video-gpu/native").iterdir():
            if path.is_file():
                self.assertIn(str(path.relative_to(ROOT)), allowed)
        for relative in SOURCE_FILES:
            if not relative.endswith((".ts", ".mjs")):
                continue
            path = ROOT / relative
            for imported in re.findall(r"from\s+['\"](\.[^'\"]+)['\"]", path.read_text()):
                if imported.endswith("/postgres"):
                    self.assertIn("workers/video-gpu/postgres.mjs", allowed)
                    continue
                resolved = (path.parent / imported).resolve()
                if not resolved.suffix:
                    resolved = resolved.with_suffix(".ts")
                self.assertIn(str(resolved.relative_to(ROOT)), allowed)
        self.assertNotIn("lib/postgres.ts", allowed)

    def test_bundle_verifier_rejects_wrong_commit_and_changed_bundle(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            shutil.copy(ROOT / "workers/video-gpu/verify-build.mjs", root)
            bundle = b"console.log('fixture')\n"
            (root / "worker.mjs").write_bytes(bundle)
            commit = "a" * 40
            (root / "build-info.json").write_text(
                json.dumps(
                    {"sourceCommit": commit, "bundleSha256": hashlib.sha256(bundle).hexdigest()}
                )
            )

            def verify(revision):
                return subprocess.run(
                    ["node", str(root / "verify-build.mjs"), revision],
                    capture_output=True,
                    text=True,
                )

            self.assertEqual(verify(commit).returncode, 0)
            self.assertNotEqual(verify("b" * 40).returncode, 0)
            self.assertNotEqual(verify("HEAD").returncode, 0)
            (root / "worker.mjs").write_bytes(b"stale bundle")
            self.assertNotEqual(verify(commit).returncode, 0)


if __name__ == "__main__":
    unittest.main()
