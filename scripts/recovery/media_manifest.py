#!/usr/bin/env python3
"""Compare the catalog's original files with what is actually in storage. Read-only.

Writes a private manifest (path, size, storage checksum, last modified) under
`.release/recovery/` and prints counts only. The manifest is the list a media backup
must contain and the evidence a restore is checked against. It never reads file
contents, never copies media and never prints paths.
"""
import argparse
import datetime
import json
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "release"))
from postgres_tools import tool  # noqa: E402

PROFILE = json.loads((ROOT / "config" / "deployment.json").read_text())
STAGE = f"@{PROFILE['DATABASE']}.{PROFILE['RAW_SCHEMA']}.{PROFILE['PHOTO_STAGE']}"
PREFIX = PROFILE["PHOTO_STAGE"].lower() + "/"


def catalog(service):
    """Original path and recorded size for every live and trashed file."""
    query = """
        SELECT original_stage_path, COALESCE(file_size_bytes, -1) FROM photos
        WHERE original_stage_path IS NOT NULL
        UNION ALL
        SELECT photo_data->>'original_stage_path', COALESCE((photo_data->>'file_size_bytes')::bigint, -1)
        FROM photo_trash WHERE photo_data->>'original_stage_path' IS NOT NULL
    """
    out = subprocess.run(
        [tool("psql"), f"service={service}", "-AtF", "\t", "-c", query],
        check=True, text=True, capture_output=True,
    ).stdout
    rows = {}
    for line in out.splitlines():
        path, size = line.rsplit("\t", 1)
        rows[path] = int(size)
    return rows


def storage(connection):
    """Every object under originals/ in the media stage."""
    out = subprocess.run(
        ["snow", "sql", "-c", connection, "--format", "json", "-q", f"LIST {STAGE}/originals/"],
        check=True, text=True, capture_output=True,
    ).stdout
    objects = {}
    for item in json.loads(out):
        name = item["name"]
        objects[name[len(PREFIX):] if name.startswith(PREFIX) else name] = item
    return objects


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--connection", required=True, help="Snowflake CLI connection name")
    parser.add_argument("--service", default=PROFILE["PG_SERVICE"], help="libpq service for the catalog")
    args = parser.parse_args()

    expected = catalog(args.service)
    present = storage(args.connection)
    missing = sorted(path for path in expected if path not in present)
    wrong_size = sorted(
        path for path, size in expected.items()
        if path in present and size >= 0 and int(present[path]["size"]) != size
    )
    unreferenced = sorted(path for path in present if path not in expected)

    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out = ROOT / ".release" / "recovery" / stamp
    out.mkdir(parents=True, mode=0o700)
    with (out / "media-manifest.jsonl").open("w") as handle:
        for path in sorted(expected):
            item = present.get(path)
            handle.write(json.dumps({
                "path": path,
                "catalogBytes": expected[path],
                "storedBytes": int(item["size"]) if item else None,
                "storedChecksum": item["md5"] if item else None,
                "lastModified": item["last_modified"] if item else None,
            }) + "\n")
    summary = {
        "generatedAt": stamp,
        "catalogFiles": len(expected),
        "storedObjects": len(present),
        "missingFromStorage": len(missing),
        "sizeMismatch": len(wrong_size),
        "storedButUnreferenced": len(unreferenced),
        "catalogBytes": sum(size for size in expected.values() if size >= 0),
        "storedBytes": sum(int(item["size"]) for item in present.values()),
    }
    (out / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    (out / "findings.json").write_text(json.dumps(
        {"missingFromStorage": missing, "sizeMismatch": wrong_size, "storedButUnreferenced": unreferenced},
        indent=2,
    ) + "\n")
    print(json.dumps(summary, indent=2))
    print(f"Manifest: {out}")
    return 1 if missing or wrong_size else 0


if __name__ == "__main__":
    raise SystemExit(main())
