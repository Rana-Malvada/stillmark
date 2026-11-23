"""Prove local files cannot leak into a release and the source is the checked commit."""

import hashlib
import pathlib
import subprocess
import tempfile
import unittest
from source_snapshot import snapshot


class SourceSnapshot(unittest.TestCase):
    def test_only_committed_source_is_released(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            repo, release = root / "repo", root / "release"
            repo.mkdir()
            release.mkdir()

            def git(*args):
                return subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True, text=True).stdout.strip()

            git("init")
            git("config", "user.name", "Release test")
            git("config", "user.email", "release@example.invalid")
            (repo / ".gitignore").write_text(".env*\n.DS_Store\ntmp/\n")
            (repo / "app.yml").write_text("version: 2\n")
            (repo / "source.ts").write_text("export const version = 1\n")
            git("add", ".")
            git("commit", "-m", "fixture")
            commit = git("rev-parse", "HEAD")
            (repo / ".env.local").write_text("private fixture only")
            (repo / ".DS_Store").write_text("private")
            (repo / "tmp").mkdir()
            (repo / "tmp/screenshot.png").write_text("private")
            (repo / "untracked.txt").write_text("private")
            (repo / "source.ts").write_text("uncommitted change")
            source, digest = snapshot(repo, commit, release)
            self.assertEqual((source / "source.ts").read_text(), "export const version = 1\n")
            self.assertEqual({p.name for p in source.iterdir()}, {".gitignore", "app.yml", "source.ts"})
            self.assertEqual(digest, hashlib.sha256((release / "source.tar").read_bytes()).hexdigest())

    def test_missing_commit_never_creates_deployable_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            subprocess.run(["git", "init", str(root)], check=True, capture_output=True)
            with self.assertRaises(subprocess.CalledProcessError):
                snapshot(root, "invalid-commit", root)
            self.assertEqual(list((root / "source").iterdir()), [])


if __name__ == "__main__":
    unittest.main()
