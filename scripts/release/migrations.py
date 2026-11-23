"""Future Postgres migrations only. Legacy setup scripts are inventoried, never replayed."""

import argparse, hashlib, json, pathlib, re
from common import ROOT, sql, quote, run
from sql_guard import transactional

p = argparse.ArgumentParser()
p.add_argument("action", choices=["baseline", "check", "apply"])
a = p.parse_args()
files = sorted((ROOT / "migrations/postgres").glob("*.sql"))


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


if a.action == "baseline":
    legacy = {
        str(f.relative_to(ROOT)): digest(f)
        for f in sorted((ROOT / "setup").rglob("*"))
        if f.is_file()
    }
    sql(
        "BEGIN;CREATE SCHEMA IF NOT EXISTS release_control;REVOKE ALL ON SCHEMA release_control FROM PUBLIC;CREATE TABLE IF NOT EXISTS release_control.migrations(name text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now());CREATE TABLE IF NOT EXISTS release_control.baselines(id integer PRIMARY KEY CHECK(id=1),recorded_at timestamptz NOT NULL DEFAULT now(),legacy_inventory jsonb NOT NULL);INSERT INTO release_control.baselines(id,legacy_inventory) VALUES(1,"
        + quote(json.dumps(legacy))
        + "::jsonb) ON CONFLICT DO NOTHING;COMMIT;"
    )
    print("Baseline recorded: legacy files inventoried, NOT claimed executed.")
    raise SystemExit
rows = json.loads(sql("SELECT coalesce(json_agg(m),'[]') FROM release_control.migrations m"))
applied = {r["name"]: r["sha256"] for r in rows}
local = {f.name: digest(f) for f in files}
for name, sha in applied.items():
    if local.get(name) != sha:
        raise SystemExit("Applied migration missing or modified: " + name)
# Validate every pending file before an expensive restore drill or any mutation.
for f in files:
    if not re.fullmatch(r"\d{8,14}_[a-z0-9_]+\.sql", f.name):
        raise SystemExit("Invalid migration filename: " + f.name)
    if f.name not in applied and not transactional(f.read_text()):
        raise SystemExit("Migration must be transactional without transaction control: " + f.name)
if a.action == "apply" and any(f.name not in applied for f in files):
    run(["python3", str(ROOT / "scripts/verify-backup.py")], cwd=ROOT)
for f in files:
    if not re.fullmatch(r"\d{8,14}_[a-z0-9_]+\.sql", f.name):
        raise SystemExit("Invalid migration filename: " + f.name)
    if f.name in applied:
        continue
    if a.action == "check":
        raise SystemExit(
            "Pending migration: "
            + f.name
            + "; review compatibility and run backup verification before applying"
        )
    text = f.read_text()
    # Require a single transaction. Forbid psql commands and transaction escapes.
    if not transactional(text):
        raise SystemExit("Migration must be transactional without transaction control: " + f.name)
    sql(
        "BEGIN;SELECT pg_advisory_xact_lock(hashtextextended('personal-photos-migrations',0));DO $$ BEGIN IF EXISTS(SELECT FROM release_control.migrations WHERE name="
        + quote(f.name)
        + ") THEN RAISE EXCEPTION 'Migration already applied; rerun check'; END IF; END $$;"
        + text
        + "\nINSERT INTO release_control.migrations(name,sha256) VALUES("
        + quote(f.name)
        + ","
        + quote(local[f.name])
        + ");COMMIT;"
    )
    print("Applied " + f.name)
print("Migration checks passed")
