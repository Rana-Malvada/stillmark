import os
import pathlib
import tempfile
import types
import unittest
from unittest.mock import patch

from postgres_tools import backup_clients, major_version, tool


class PostgresToolsTests(unittest.TestCase):
    def test_path_is_preferred(self):
        with patch.dict(os.environ, {}, clear=True), patch("shutil.which", return_value="/usr/bin/psql"):
            self.assertEqual(tool("psql"), "/usr/bin/psql")

    def test_explicit_override_is_executable_and_never_falls_back(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"GALLERY_PG_BIN": directory}), patch("shutil.which", return_value="/wrong/psql") as which:
            with self.assertRaisesRegex(RuntimeError, "GALLERY_PG_BIN"):
                tool("psql")
            client = pathlib.Path(directory) / "psql"
            client.write_text("#!/bin/sh\n")
            with self.assertRaisesRegex(RuntimeError, "executable"):
                tool("psql")
            client.chmod(0o700)
            self.assertEqual(tool("psql"), str(client.resolve()))
            which.assert_not_called()

    def test_missing_client_has_actionable_error(self):
        with patch.dict(os.environ, {}, clear=True), patch("shutil.which", return_value=None), patch("pathlib.Path.is_file", return_value=False):
            with self.assertRaisesRegex(RuntimeError, "PATH or set GALLERY_PG_BIN"):
                tool("pg_dump")

    def clients(self, server, versions):
        def version(args, **kwargs):
            self.assertEqual(args[1], "--version")
            return types.SimpleNamespace(stdout=f"{args[0]} (PostgreSQL) {versions[args[0]]}.1")
        with patch("postgres_tools.tool", side_effect=lambda name: name), patch("subprocess.run", side_effect=version):
            return backup_clients(server)

    def test_matching_and_newer_clients_preflight(self):
        for version in (17, 18):
            _, report = self.clients("170006", {name: version for name in ("psql", "pg_dump", "pg_restore")})
            self.assertEqual(report["serverMajor"], 17)
            self.assertEqual(report["clientMajors"]["pg_dump"], version)

    def test_old_or_mixed_client_majors_block_before_backup(self):
        for versions in (
            {"psql": 16, "pg_dump": 16, "pg_restore": 16},
            {"psql": 18, "pg_dump": 18, "pg_restore": 17},
            {"psql": 17, "pg_dump": 18, "pg_restore": 18},
        ):
            with self.subTest(versions=versions), self.assertRaisesRegex(RuntimeError, "requires one client major"):
                self.clients("170006", versions)

    def test_malformed_version_fails_closed(self):
        for text in ("unknown", "psql 18.1", "psql (PostgreSQL) 9.6"):
            with self.assertRaises(RuntimeError):
                major_version(text)


if __name__ == "__main__":
    unittest.main()
