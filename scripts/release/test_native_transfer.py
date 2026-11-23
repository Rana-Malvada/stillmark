"""Reject untrusted/stale native artifact provenance before seeding build cache."""

import hashlib
import json
import pathlib
import tempfile
import unittest
from unittest.mock import patch
import native_cache_transfer as transfer


class NativeTransferTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temporary.name)
        self.native = self.root / "native"
        self.native.mkdir()
        (self.native / "source.patch").write_text("reviewed official patch")
        (self.native / "build-inputs.json").write_text(
            json.dumps({"files": ["source.patch", "build-inputs.json"]})
        )
        self.binding = patch.object(transfer, "NATIVE", self.native)
        self.binding.start()
        self.recipe = self.root / "Dockerfile"
        self.recipe.write_text("FROM pinned-base\nRUN build")
        self.recipe_binding = patch.object(transfer, "RECIPE", self.recipe)
        self.recipe_binding.start()
        self.identity = {
            "recipeSHA256": transfer.digest(self.recipe),
            "inputs": {p.name: transfer.digest(p) for p in self.native.iterdir()},
        }
        self.key = hashlib.sha256(json.dumps(self.identity, sort_keys=True).encode()).hexdigest()
        self.export = self.root / "export"
        self.entry = self.export / self.key
        self.entry.mkdir(parents=True)
        (self.entry / "runtime.tar.gz").write_bytes(
            b"archive fixture; Docker performs safe extraction"
        )
        (self.entry / "manifest.json").write_text(
            json.dumps(
                {
                    "identity": self.identity,
                    "archiveSHA256": transfer.digest(self.entry / "runtime.tar.gz"),
                }
            )
        )
        self.receipt = {
            "commit": "a" * 40,
            "repository": "owner/repo",
            "runId": "42",
            "files": {
                str(p.relative_to(self.export)): transfer.digest(p) for p in self.entry.iterdir()
            },
        }
        (self.export / "receipt.json").write_text(json.dumps(self.receipt))
        self.run = {
            "head_sha": "a" * 40,
            "status": "completed",
            "conclusion": "success",
            "path": "docs/reference/github-quality-workflow.yml",
            "repository": {"full_name": "owner/repo"},
        }

    def tearDown(self):
        self.binding.stop()
        self.recipe_binding.stop()
        self.temporary.cleanup()

    def validate(self):
        return transfer.validate_export(self.export, "a" * 40, "owner/repo", 42)

    def test_matching_authenticated_export(self):
        transfer.validate_run(self.run, "a" * 40, "owner/repo")
        self.assertEqual(self.validate(), self.entry)

    def test_wrong_run_commit_repository_workflow_or_status_rejected(self):
        cases = [
            ("head_sha", "b" * 40),
            ("conclusion", "failure"),
            ("status", "in_progress"),
            ("path", ".github/workflows/other.yml"),
            ("repository", {"full_name": "attacker/repo"}),
        ]
        for key, value in cases:
            with self.subTest(key=key), self.assertRaises(ValueError):
                transfer.validate_run({**self.run, key: value}, "a" * 40, "owner/repo")

    def test_wrong_receipt_identity_rejected(self):
        for key, value in [("commit", "b" * 40), ("repository", "other/repo"), ("runId", 43)]:
            (self.export / "receipt.json").write_text(json.dumps({**self.receipt, key: value}))
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.validate()

    def test_changed_source_rejected(self):
        (self.native / "source.patch").write_text("changed")
        with self.assertRaisesRegex(ValueError, "source input"):
            self.validate()

    def test_changed_compiler_recipe_rejected(self):
        self.recipe.write_text("FROM different-base\nRUN other-build")
        with self.assertRaisesRegex(ValueError, "compiler recipe"):
            self.validate()

    def test_changed_archive_rejected(self):
        (self.entry / "runtime.tar.gz").write_bytes(b"tampered")
        with self.assertRaisesRegex(ValueError, "digest mismatch"):
            self.validate()

    def test_changed_receipt_digest_rejected(self):
        self.receipt["files"][self.key + "/manifest.json"] = "0" * 64
        (self.export / "receipt.json").write_text(json.dumps(self.receipt))
        with self.assertRaisesRegex(ValueError, "receipt digest"):
            self.validate()

    def test_additional_unbound_file_rejected(self):
        (self.entry / "extra").write_text("unexpected")
        with self.assertRaisesRegex(ValueError, "receipt digest"):
            self.validate()


if __name__ == "__main__":
    unittest.main()
