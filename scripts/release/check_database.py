"""Required native PostgreSQL correctness checks; disposable local containers only."""

import datetime
import hashlib
import json
import os
import pathlib
import re
import uuid

from common import ROOT, run

CHECKS = (
    "scripts/verification/local-postgres-cleanup.mjs",
    "scripts/verification/permission-workflows.mjs",
    "scripts/verification/backup-restore.mjs",
    "scripts/verification/upload-admission-cleanup.mjs",
    "scripts/verification/album-locks.mjs",
    "scripts/verification/album-count.mjs",
    "scripts/verification/stage-cleanup.mjs",
    "scripts/verification/photo-ai-admission.mjs",
    "scripts/verification/worker-cost-recovery.mjs",
    "scripts/verification/automatic-work.mjs",
    "scripts/verification/search-ocr-recovery.mjs",
    "scripts/verification/bounded-face-merge.mjs",
    "scripts/verification/video-playback-failure.mjs",
    "scripts/verification/people-counts-query-plans.mjs",
    "scripts/verification/people-name-concurrency.mjs",
    "scripts/verification/photo-ai-notifications.mjs",
    "scripts/verification/gallery-statistics.mjs",
    "scripts/verification/search-delete-cleanup.mjs",
    "scripts/verification/search-update.mjs",
    "scripts/verification/search-rerank-publication.mjs",
    "scripts/verification/upload-account-authority.mjs",
    "scripts/verification/load-database-sample.mjs",
    "scripts/auth0/verify-credential-recovery.mjs",
)


def source_snapshot(root):
    def git(*args):
        return run(["git", *args], cwd=root, capture_output=True, timeout=30).stdout

    digest = hashlib.sha256()
    paths = set(git("ls-files", "-z", "--cached", "--others", "--exclude-standard").split("\0"))
    for name in sorted(paths - {""}):
        path = root / name
        digest.update(name.encode() + b"\0")
        if path.is_symlink():
            digest.update(os.readlink(path).encode())
        elif path.is_file():
            digest.update(path.read_bytes())
        else:
            digest.update(b"<deleted>")
        digest.update(b"\0")
    return {
        "commit": git("rev-parse", "HEAD").strip(),
        "dirty": bool(git("status", "--porcelain")),
        "sourceSha256": digest.hexdigest(),
    }


def cleanup(run_id):
    # Child timeouts can bypass their finally blocks. Remove only this gate's
    # labelled containers; never touch other local development databases.
    ids = run(
        ["docker", "ps", "-aq", "--filter", f"label=stillmark.database-gate={run_id}"],
        capture_output=True,
        timeout=30,
    ).stdout.split()
    if any(not re.fullmatch(r"[a-f0-9]{12,64}", value) for value in ids):
        raise RuntimeError("Unexpected Docker container identifier")
    if ids:
        run(["docker", "rm", "-f", "-v", *ids], capture_output=True, timeout=30)


def check_database(root=ROOT):
    run_id = str(uuid.uuid4())
    started = datetime.datetime.now(datetime.timezone.utc)
    directory = root / ".release" / "database-checks" / run_id
    directory.mkdir(parents=True, mode=0o700)
    record = {
        **source_snapshot(root),
        "startedAt": started.isoformat(),
        "status": "running",
        "checks": [],
    }
    try:
        # No implicit image pull or remote database fallback.
        run(["docker", "image", "inspect", "postgres:17"], capture_output=True, timeout=30)
        run(
            [
                "docker",
                "image",
                "inspect",
                "pgvector/pgvector:0.8.1-pg17-bookworm@sha256:3e8b3adfd27b5707128f60956f62a793c3c9326ea8cfaf0eab7adccb5d700b21",
            ],
            capture_output=True,
            timeout=30,
        )
        for script in CHECKS:
            result = {"script": script, "status": "running"}
            record["checks"].append(result)
            try:
                run(
                    ["node", script],
                    cwd=root,
                    env={**os.environ, "STILLMARK_DATABASE_GATE_RUN": run_id},
                    timeout=180,
                )
                result["status"] = "passed"
            except BaseException:
                result["status"] = "failed"
                raise
        if source_snapshot(root) != {
            key: record[key] for key in ("commit", "dirty", "sourceSha256")
        }:
            raise RuntimeError("Source changed during database checks")
        record["status"] = "passed"
    except BaseException:
        record["status"] = "failed"
        raise
    finally:
        try:
            cleanup(run_id)
        except BaseException:
            record["status"] = "failed"
            record["cleanupFailed"] = True
            raise
        finally:
            record["finishedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
            (directory / "result.json").write_text(json.dumps(record, indent=2) + "\n")
            print("Database validation evidence: " + str(directory / "result.json"))


if __name__ == "__main__":
    check_database()
