"""Exercise failure gates without calling any provider or database."""

import pathlib, runpy, sys, tempfile, types, unittest
from unittest.mock import patch
from sql_guard import transactional

DEPLOY = pathlib.Path(__file__).with_name("deploy.py")
MIGRATIONS = pathlib.Path(__file__).with_name("migrations.py")


class Safety(unittest.TestCase):
    def deploy(self, dirty=False, fail=False, deploy=False):
        calls = []

        def run(args, **kw):
            calls.append(args)
            if args[:3] == ["git", "status", "--porcelain"]:
                return types.SimpleNamespace(stdout=" M code" if dirty else "")
            if args[:2] == ["git", "rev-parse"]:
                return types.SimpleNamespace(stdout="abc123")
            if fail and "scripts/release/check.py" in args:
                raise RuntimeError("test failure")
            return types.SimpleNamespace(stdout="")

        with tempfile.TemporaryDirectory() as tmp:
            module = types.SimpleNamespace(ROOT=pathlib.Path(tmp), run=run)
            with (
                patch.dict(sys.modules, {"common": module}),
                patch.object(sys, "argv", ["deploy.py"] + (["--deploy"] if deploy else [])),
                patch("os.chdir"),
            ):
                with self.assertRaises((SystemExit, RuntimeError)):
                    runpy.run_path(str(DEPLOY), run_name="__main__")
        self.assertFalse(any(c[0] == "snow" for c in calls))
        return calls

    def test_transaction_guard(self):
        self.assertTrue(
            transactional(
                "CREATE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;"
            )
        )
        for body in [
            "COMMIT;",
            "SELECT 'COMMIT'; COMMIT;",
            "/* nested /* comment */ */ ROLLBACK;",
            "START TRANSACTION;",
            "END;",
            "ABORT;",
            "VACUUM x;",
            "CREATE INDEX CONCURRENTLY x ON y(z);",
            "\\i unsafe.sql",
        ]:
            self.assertFalse(transactional(body), body)
        with self.assertRaises(ValueError):
            transactional("SELECT $$unterminated")

    def test_case_expression_is_not_transaction_end(self):
        self.assertTrue(
            transactional("CREATE POLICY p ON t USING(CASE WHEN x THEN true ELSE false END);")
        )
        for text in [
            "END WORK;",
            "SELECT CASE WHEN true THEN 1 ELSE 0 END; END;",
            "SELECT 1; /* comment */ END TRANSACTION;",
        ]:
            self.assertFalse(transactional(text), text)

    def test_pending_repository_migrations_are_transactional(self):
        for path in (MIGRATIONS.parents[2] / "migrations/postgres").glob("*.sql"):
            self.assertTrue(transactional(path.read_text()), str(path))

    def test_dirty_tree_stops_before_checks(self):
        self.assertEqual(len(self.deploy(dirty=True)), 1)

    def test_failed_checks_cannot_deploy(self):
        self.deploy(fail=True, deploy=True)

    def test_default_is_check_only(self):
        self.deploy()

    def migration(self, applied, local):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            (root / "migrations/postgres").mkdir(parents=True)
            for n, body in local.items():
                (root / "migrations/postgres" / n).write_text(body)
            calls = []

            def sql(s):
                calls.append(s)
                return applied

            module = types.SimpleNamespace(
                ROOT=root, sql=sql, quote=lambda s: "'" + s + "'", run=lambda *a, **k: None
            )
            with (
                patch.dict(sys.modules, {"common": module}),
                patch.object(sys, "argv", ["migrations.py", "check"]),
            ):
                with self.assertRaises(SystemExit):
                    runpy.run_path(str(MIGRATIONS), run_name="__main__")
            self.assertEqual(len(calls), 1)

    def test_pending_migration_stops_release(self):
        self.migration("[]", {"20261004_test.sql": "SELECT 1;"})

    def test_missing_applied_migration_stops_release(self):
        self.migration('[{"name":"20261004_test.sql","sha256":"a"}]', {})

    def test_changed_migration_stops_release(self):
        self.migration(
            '[{"name":"20261004_test.sql","sha256":"a"}]', {"20261004_test.sql": "SELECT 2;"}
        )


if __name__ == "__main__":
    unittest.main()
