"""Fail-closed orchestration tests; no Docker, database, or credentials required."""

import contextlib
import io
import json
import os
import runpy
import pathlib
import subprocess
import tempfile
import types
import unittest
from unittest.mock import patch

import check_database as gate


class DatabaseGate(unittest.TestCase):
    def exercise(self, *, failure=None, drift=False):
        calls = []
        source = {"commit": "abc123", "dirty": False, "sourceSha256": "a"}

        def run(args, **kwargs):
            calls.append((args, kwargs))
            if args == ["node", gate.CHECKS[0]] and failure:
                raise failure
            return types.SimpleNamespace(
                stdout="abc123abc123\n" if args[:3] == ["docker", "ps", "-aq"] else ""
            )

        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            with (
                patch.object(gate, "run", side_effect=run),
                patch.object(
                    gate,
                    "source_snapshot",
                    side_effect=[source, {**source, "sourceSha256": "b"} if drift else source],
                ),
            ):
                if failure or drift:
                    with self.assertRaises(type(failure) if failure else RuntimeError):
                        gate.check_database(root)
                else:
                    gate.check_database(root)
            records = list((root / ".release/database-checks").glob("*/result.json"))
            self.assertEqual(len(records), 1)
            record = json.loads(records[0].read_text())
        self.assertTrue(
            any(args == ["docker", "rm", "-f", "-v", "abc123abc123"] for args, _ in calls)
        )
        return calls, record

    def test_failure_stops_remaining_checks_and_preserves_failure_evidence(self):
        calls, record = self.exercise(failure=subprocess.CalledProcessError(1, "node"))
        self.assertEqual(
            [args for args, _ in calls if args[0] == "node"], [["node", gate.CHECKS[0]]]
        )
        self.assertEqual(record["status"], "failed")
        self.assertEqual(record["checks"][0]["status"], "failed")

    def test_timeout_cleans_its_own_containers(self):
        calls, record = self.exercise(failure=subprocess.TimeoutExpired("node", 180))
        invocation = next(kwargs for args, kwargs in calls if args[0] == "node")
        run_id = invocation["env"]["STILLMARK_DATABASE_GATE_RUN"]
        self.assertTrue(any(f"label=stillmark.database-gate={run_id}" in args for args, _ in calls))
        self.assertEqual(record["status"], "failed")

    def test_source_drift_cannot_receive_a_passing_record(self):
        _, record = self.exercise(drift=True)
        self.assertEqual(record["status"], "failed")

    def test_success_records_every_required_check_and_source_identity(self):
        calls, record = self.exercise()
        self.assertEqual(record["status"], "passed")
        self.assertEqual(record["commit"], "abc123")
        self.assertEqual([item["script"] for item in record["checks"]], list(gate.CHECKS))
        self.assertTrue(
            all(kwargs["timeout"] == 180 for args, kwargs in calls if args[0] == "node")
        )



class BackupExtensions(unittest.TestCase):
    """Exercise the complete restore orchestrator without live credentials."""

    def exercise(self, *, extensions="pg_cron|cron\nvector|public\n", required=0):
        script = pathlib.Path(__file__).resolve().parents[1] / "verify-backup.py"
        statements = []
        original_directory = pathlib.Path.cwd()

        def run(args, **kwargs):
            tool = pathlib.Path(args[0]).name
            output = ""
            if args[-1] == "--version":
                output = f"{tool} (PostgreSQL) 18.6"
            elif tool == "psql":
                statement = args[-1]
                statements.append(statement)
                if statement == "SHOW server_version_num":
                    output = "170006"
                elif statement == "SELECT current_database()":
                    output = "postgres"
                elif statement.startswith("SELECT e.extname"):
                    output = extensions
                elif "WITH RECURSIVE dumped_namespaces" in statement:
                    output = str(required)
                elif "SELECT count(*) FROM pg_proc" in statement:
                    output = "93"
                elif "BEGIN;SET LOCAL ROLE" in statement:
                    output = "BEGIN\nSET\n0\nROLLBACK\n"
                elif "SELECT count(*) FROM public." in statement:
                    output = "1"
                elif "LEFT JOIN events" in statement:
                    output = "0"
            return types.SimpleNamespace(returncode=0, stdout=output, stderr="")

        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            password_file = root / "test.pgpass"
            password_file.write_text("localhost:5432:postgres:test:fixture-only\n")
            try:
                os.chdir(root)
                with patch("postgres_tools.tool", side_effect=lambda name: name), patch.dict(os.environ, {"PGPASSFILE": str(password_file)}), patch(
                    "subprocess.run", side_effect=run
                ), contextlib.redirect_stdout(io.StringIO()):
                    if required:
                        with self.assertRaisesRegex(RuntimeError, "depends on database-bound pg_cron"):
                            runpy.run_path(str(script))
                    else:
                        runpy.run_path(str(script))
                reports = list(root.glob(".deployment-backups/*/result.json"))
                report = json.loads(reports[0].read_text()) if reports else None
            finally:
                os.chdir(original_directory)
        self.assertTrue(any(x.startswith("DROP DATABASE") for x in statements))
        self.assertFalse(any("CREATE EXTENSION IF NOT EXISTS \"pg_cron\"" in x for x in statements))
        self.assertFalse(any("ALTER SYSTEM" in x for x in statements))
        return statements, report

    def test_operational_cron_excluded_but_vector_and_permission_restore_retained(self):
        statements, report = self.exercise()
        self.assertIn('CREATE EXTENSION IF NOT EXISTS "vector" SCHEMA "public"', statements)
        self.assertEqual(report["extensions"], ["vector"])
        self.assertEqual(report["excludedOperationalExtensions"][0]["name"], "pg_cron")
        self.assertIn(
            (pathlib.Path(__file__).resolve().parents[1] / "verification/restored-permissions.sql").read_text(),
            statements,
        )
        dependency_query = next(x for x in statements if "WITH RECURSIVE" in x)
        self.assertIn("JOIN pg_depend", dependency_query)
        self.assertIn("'release_control'", dependency_query)

    def test_required_cron_fails_closed_and_cleans_disposable_database(self):
        statements, report = self.exercise(required=1)
        self.assertIsNone(report)
        self.assertFalse(any("CREATE EXTENSION" in x for x in statements))

    def test_source_without_cron_keeps_existing_extension_behavior(self):
        statements, report = self.exercise(extensions="vector|public\npg_stat_statements|public\n")
        self.assertEqual(report["extensions"], ["vector", "pg_stat_statements"])
        self.assertEqual(report["excludedOperationalExtensions"], [])
        self.assertFalse(any("WITH RECURSIVE" in x for x in statements))


if __name__ == "__main__":
    unittest.main()
