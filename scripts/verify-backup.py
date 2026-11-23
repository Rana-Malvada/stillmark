#!/usr/bin/env python3
"""Create a private catalog backup and restore it into a disposable database.
Uses an existing libpq service; never reads or prints its credentials.
"""
import datetime, json, os, pathlib, re, subprocess, uuid, tempfile, sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent / "release"))
from postgres_tools import tool as discover_tool, backup_clients

clients = {}
profile = json.loads(
    (pathlib.Path(__file__).resolve().parents[1] / "config/deployment.json").read_text()
)
service = os.environ.get("GALLERY_PG_SERVICE", profile["PG_SERVICE"])
target = "gallery_restore_check_" + uuid.uuid4().hex
out = pathlib.Path(".deployment-backups") / (
    "restore-" + datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
)
out.mkdir(parents=True, mode=0o700)
os.umask(0o077)


def run(tool, *args):
    result = subprocess.run([clients.get(tool) or discover_tool(tool), *args], text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError(f"{tool} failed: {result.stderr[:2000]}")
    return result.stdout


def sql(database, statement):
    return run(
        "psql",
        f"service={service}" + (f" dbname={database}" if database else ""),
        "-X",
        "-v",
        "ON_ERROR_STOP=1",
        "-At",
        "-c",
        statement,
    )


clients, compatibility = backup_clients(sql(None, "SHOW server_version_num").strip())
source_database = sql(None, "SELECT current_database()").strip()
if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", source_database):
    raise RuntimeError("Unexpected source database name")

archive = out / "catalog.dump"
run(
    "pg_dump",
    f"--dbname=service={service}",
    "--format=custom",
    "--schema=public",
    "--schema=photo_security",
    "--schema=face_worker",
    "--schema=release_control",
    f"--file={archive}",
)
created = False
# Existing pgpass entries may be scoped to postgres. Extend only in a private,
# short-lived file for the random restore database; never modify the user's file.
original_passfile = os.environ.get("PGPASSFILE", str(pathlib.Path.home() / ".pgpass"))
password_file = tempfile.NamedTemporaryFile(mode="w", prefix="gallery-restore-", delete=False)
try:
    original = pathlib.Path(original_passfile).read_text() if pathlib.Path(original_passfile).exists() else ""
    password_file.write(original + "\n" + original.replace(":" + source_database + ":", ":" + target + ":"))
    password_file.close()
    os.environ["PGPASSFILE"] = password_file.name

    sql("postgres", f'CREATE DATABASE "{target}"')
    created = True
    # Schema-scoped dumps exclude extensions, which are database-level objects. Recreate
    # the source's extensions first so dependent types (for example vector) restore.
    # pg_cron is database-bound operational configuration, outside this dump.
    # Exclude it only after checking recorded dependencies from every dumped schema.
    extensions = [
        line.split("|")
        for line in sql(
            source_database,
            "SELECT e.extname||'|'||n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace"
            " WHERE e.extname<>'plpgsql' ORDER BY e.extname",
        ).splitlines()
        if line
    ]
    excluded_extensions = []
    if any(name == "pg_cron" for name, _ in extensions):
        cron_required = int(
            sql(
                source_database,
                """
WITH RECURSIVE dumped_namespaces AS (
    SELECT oid FROM pg_namespace
    WHERE nspname IN ('public', 'photo_security', 'face_worker', 'release_control')
), required_objects(classid, objid) AS (
    SELECT d.classid, d.objid FROM pg_depend d
    WHERE d.refclassid = 'pg_namespace'::regclass
      AND d.refobjid IN (SELECT oid FROM dumped_namespaces)
    UNION
    SELECT d.refclassid, d.refobjid
    FROM required_objects r JOIN pg_depend d
      ON d.classid = r.classid AND d.objid = r.objid
)
SELECT count(*) FROM required_objects r JOIN pg_extension e
  ON r.classid = 'pg_extension'::regclass AND r.objid = e.oid
WHERE e.extname = 'pg_cron'
""",
            )
        )
        if cron_required:
            raise RuntimeError(
                "Dumped catalog depends on database-bound pg_cron; "
                "restore requires an explicitly reviewed backup scope. "
                "No server configuration was changed."
            )
        extensions = [(name, schema) for name, schema in extensions if name != "pg_cron"]
        excluded_extensions.append(
            {
                "name": "pg_cron",
                "reason": "Database-bound monitoring outside dumped schemas; no recorded catalog dependency",
            }
        )
    for name, schema in extensions:
        if not (
            re.fullmatch(r"[a-z][a-z0-9_]*", name) and re.fullmatch(r"[a-z][a-z0-9_]*", schema)
        ):
            raise RuntimeError("Unexpected extension or schema name in source database")
        if not schema.startswith("pg_"):
            sql(target, f'CREATE SCHEMA IF NOT EXISTS "{schema}"')
        sql(target, f'CREATE EXTENSION IF NOT EXISTS "{name}" SCHEMA "{schema}"')
    extensions = [name for name, _ in extensions]
    # Managed Postgres precreates public with system extensions; preserve it.
    toc = run("pg_restore", "--list", str(archive))
    restore_list = out / "restore.list"
    restore_list.write_text(
        "\n".join(
            line
            for line in toc.splitlines()
            if " SCHEMA - public " not in line
            and " COMMENT - SCHEMA public " not in line
            and " DEFAULT ACL public DEFAULT PRIVILEGES FOR TABLES application" not in line
        )
        + "\n"
    )
    run(
        "pg_restore",
        f"--dbname=service={service} dbname={target}",
        "--exit-on-error",
        f"--use-list={restore_list}",
        str(archive),
    )
    security = int(
        sql(
            target,
            "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='photo_security'",
        )
    )
    if security < 10:
        raise RuntimeError("Security functions missing from restored database")
    denied = int(
        sql(
            target, "BEGIN;SET LOCAL ROLE personal_photos_app;SELECT count(*) FROM photos;ROLLBACK;"
        ).splitlines()[-2]
    )
    if denied:
        raise RuntimeError("Restored RLS did not fail closed")
    permission_checks = pathlib.Path(__file__).parent / "verification/restored-permissions.sql"
    sql(target, permission_checks.read_text())
    counts = {
        table: int(sql(target, f"SELECT count(*) FROM public.{table}"))
        for table in [
            "photos",
            "events",
            "album_shares",
            "gallery_access_objects",
            "gallery_main_admins",
        ]
    }
    if not counts["photos"] or not counts["events"]:
        raise RuntimeError("Expected gallery catalog is empty")
    orphans = int(
        sql(
            target,
            "SELECT count(*) FROM photos p LEFT JOIN events e USING(event_id) WHERE e.event_id IS NULL",
        )
    )
    if orphans:
        raise RuntimeError("Restored catalog has orphaned photos")
    report = {
        "checkedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "restored": True,
        "clientCompatibility": compatibility,
        "sourceDatabase": source_database,
        "counts": counts,
        "orphanPhotos": orphans,
        "securityFunctions": security,
        "unscopedPhotos": denied,
        "permissionWorkflows": "passed: owner, unrelated viewer, read-only owner, share/revoke, public link/revoke, authority-table denial, no elevated app-role grants; synthetic rows rolled back",
        "extensions": extensions,
        "excludedOperationalExtensions": excluded_extensions,
        "managedDefaultsExcluded": "Snowflake-owned application role default ACL only; application object ACLs restored",
        "scope": "public, photo_security, face_worker and release_control schema/data, object owners and grants; existing cluster roles required. Extensions listed above must be created before restoring. Media and external service configuration are separate",
        "archive": str(archive),
    }
    (out / "result.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
finally:
    try:
        if created:
            sql("postgres", f'DROP DATABASE "{target}" WITH (FORCE)')
    finally:
        pathlib.Path(password_file.name).unlink(missing_ok=True)
