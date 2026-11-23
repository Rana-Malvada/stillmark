"""Isolated stage chunk feasibility test. No gallery catalog or PostgreSQL writes."""

import hashlib, json, os, pathlib, subprocess, tempfile, time, uuid

profile = json.loads(
    (pathlib.Path(__file__).resolve().parents[1] / "config/deployment.json").read_text()
)

snow = "/opt/homebrew/bin/snow"
prefix = "_upload_probe/" + uuid.uuid4().hex
stage = (
    "@"
    + ".".join(profile[k] for k in ("DATABASE", "RAW_SCHEMA", "PHOTO_STAGE"))
    + "/"
    + prefix
    + "/"
)
report = {
    "prefix": prefix,
    "role": profile["RESOURCE_PERSONAL_PHOTOS_RUNTIME"],
    "chunk_bytes": 8388608,
    "chunks": 3,
    "steps": [],
}


def sql(query):
    start = time.monotonic()
    p = subprocess.run(
        [
            snow,
            "sql",
            "-c",
            profile["CLI_CONNECTION"],
            "--role",
            profile["RESOURCE_PERSONAL_PHOTOS_RUNTIME"],
            "--secondary-roles",
            "NONE",
            "-q",
            query,
            "--format",
            "json",
        ],
        capture_output=True,
        text=True,
    )
    if p.returncode:
        raise RuntimeError(p.stderr[-1500:])
    data = json.loads(p.stdout)
    report["steps"].append({"seconds": round(time.monotonic() - start, 2), "rows": len(data)})
    return data


try:
    with tempfile.TemporaryDirectory(prefix="photo-stage-probe-") as root:
        root = pathlib.Path(root)
        source = root / "source"
        dest = root / "download"
        source.mkdir()
        dest.mkdir()
        expected = hashlib.sha256()
        for i in range(3):
            data = os.urandom(8388608)
            expected.update(data)
            (source / f"part-{i:04}.bin").write_bytes(data)
        # First chunk, then fresh CLI connections for the remaining chunks simulate resume.
        for i in range(3):
            rows = sql(
                f"PUT 'file://{source}/part-{i:04}.bin' '{stage}' AUTO_COMPRESS=FALSE OVERWRITE=TRUE"
            )
            if not rows or any(
                str(r.get("status", r.get("STATUS"))).upper() not in ("UPLOADED", "SKIPPED")
                for r in rows
            ):
                raise RuntimeError("PUT not successful")
        rows = sql(
            f"PUT 'file://{source}/part-0001.bin' '{stage}' AUTO_COMPRESS=FALSE OVERWRITE=TRUE"
        )
        report["retry_status"] = [r.get("status", r.get("STATUS")) for r in rows]
        rows = sql(f"LIST {stage}")
        report["stored_files"] = len(rows)
        if len(rows) != 3:
            raise RuntimeError("Incorrect chunk count")
        rows = sql(f"GET {stage} 'file://{dest}/' PARALLEL=3")
        actual = hashlib.sha256()
        for i in range(3):
            actual.update((dest / f"part-{i:04}.bin").read_bytes())
        report["sha256_matches"] = actual.hexdigest() == expected.hexdigest()
        if not report["sha256_matches"]:
            raise RuntimeError("Hash mismatch")
        report["success"] = True
finally:
    try:
        sql(f"REMOVE {stage}")
        report["cleanup_verified"] = len(sql(f"LIST {stage}")) == 0
    finally:
        pathlib.Path("/tmp/photo-stage-chunks-result.json").write_text(json.dumps(report, indent=2))
        print(json.dumps(report, indent=2))
