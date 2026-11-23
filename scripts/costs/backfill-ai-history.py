#!/usr/bin/env python3
"""Freeze reviewed legacy attribution once; no automatic runtime query-text matching."""
import argparse
from collections import Counter
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import subprocess
import shutil
import tempfile

profile = json.loads((Path(__file__).resolve().parents[2] / "config/deployment.json").read_text())

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--cutoff", required=True, help="Fixed historical UTC cutoff, ISO 8601")
parser.add_argument("--connection", default=profile["CLI_CONNECTION"])
parser.add_argument("--pg-service", default=profile["PG_SERVICE"])
parser.add_argument("--psql", default=shutil.which("psql") or "/opt/homebrew/opt/libpq/bin/psql")
parser.add_argument(
    "--apply", action="store_true", help="Insert classifications; default only previews counts"
)
args = parser.parse_args()
if args.apply and not Path(args.psql).is_file():
    parser.error("psql is unavailable; pass --psql with its absolute path")
cutoff = datetime.fromisoformat(args.cutoff.replace("Z", "+00:00"))
if cutoff.tzinfo is None or cutoff > datetime.now(timezone.utc):
    parser.error("cutoff must have a timezone and cannot be in the future")
cutoff = cutoff.astimezone(timezone.utc).isoformat()
sql = Path(__file__).with_name("legacy-ai-classifications.sql").read_text().format(cutoff=cutoff)
with tempfile.NamedTemporaryFile(mode="w", suffix=".sql") as source:
    source.write(sql)
    source.flush()
    result = subprocess.run(
        ["snow", "sql", "-c", args.connection, "-f", source.name, "--format", "json"],
        check=True,
        capture_output=True,
        text=True,
    )
rows = json.loads(result.stdout)
allowed = {"photo_ai", "video_ai", "search_ai", "search_indexing"}
verified = []
for row in rows:
    if row["KIND"] not in allowed:
        continue
    if not re.fullmatch(r"[0-9a-f-]{36}", row["QUERY_ID"]) or not re.fullmatch(
        r"[A-Za-z0-9_]+", row["FUNCTION_NAME"]
    ):
        raise ValueError("Unexpected historical usage identifiers")
    verified.append(
        {
            "query_id": row["QUERY_ID"],
            "function_name": row["FUNCTION_NAME"],
            "kind": row["KIND"],
            "basis": f"Reviewed legacy signatures v1; historical cutoff {cutoff}",
        }
    )
print(
    json.dumps(
        {
            "cutoff": cutoff,
            "reviewed_classifications": dict(Counter(r["kind"] for r in verified)),
            "unattributed_records": sum(r["KIND"] not in allowed for r in rows),
            "apply": args.apply,
        },
        indent=2,
    )
)
if args.apply:
    # INSERT only: repeated runs cannot revise previously accepted evidence.
    payload = json.dumps(verified).replace("'", "''")
    insert = f"""INSERT INTO public.cost_ai_history(query_id,function_name,kind,basis)
    SELECT query_id,function_name,kind,basis FROM jsonb_to_recordset('{payload}'::jsonb)
    AS x(query_id text,function_name text,kind text,basis text)
    ON CONFLICT(query_id,function_name) DO NOTHING;
    SELECT kind,count(*) FROM public.cost_ai_history GROUP BY kind ORDER BY kind;"""
    subprocess.run(
        [args.psql, f"service={args.pg_service}", "-X", "-v", "ON_ERROR_STOP=1"],
        input=insert,
        text=True,
        check=True,
    )
