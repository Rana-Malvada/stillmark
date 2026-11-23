"""Validate the offline legacy-file gate without provider access."""

import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

GUARD = Path(__file__).with_name("check_setup.py").read_text()


class SetupGuard(unittest.TestCase):
    def check(self, change=None):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "scripts/release").mkdir(parents=True)
            (root / "setup").mkdir()
            (root / "migrations/postgres").mkdir(parents=True)
            (root / "scripts/release/check_setup.py").write_text(GUARD)
            sql = root / "setup/01-history.sql"
            sql.write_text("SELECT 1;")
            (root / "setup/legacy-checksums.json").write_text(
                json.dumps({"setup/01-history.sql": hashlib.sha256(sql.read_bytes()).hexdigest()})
            )
            if change:
                change(root)
            return subprocess.run(
                [sys.executable, str(root / "scripts/release/check_setup.py")], capture_output=True
            ).returncode

    def test_unchanged_passes(self):
        self.assertEqual(self.check(), 0)

    def test_edit_fails(self):
        self.assertNotEqual(
            self.check(
                lambda root: (root / "setup/01-history.sql").write_text("DROP TABLE photos;")
            ),
            0,
        )

    def test_deletion_fails(self):
        self.assertNotEqual(self.check(lambda root: (root / "setup/01-history.sql").unlink()), 0)

    def test_new_legacy_file_fails(self):
        self.assertNotEqual(
            self.check(lambda root: (root / "setup/02-new.sql").write_text("SELECT 2;")), 0
        )

    def test_missing_review_notes_fails(self):
        self.assertNotEqual(
            self.check(
                lambda root: (root / "migrations/postgres/20261006_test.sql").write_text(
                    "SELECT 1;"
                )
            ),
            0,
        )


if __name__ == "__main__":
    unittest.main()
