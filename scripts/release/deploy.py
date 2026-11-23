"""Checked runtime deployment. Failures retain evidence and never auto-restore data."""

import argparse, datetime, json, os, pathlib
from common import ROOT, run
from source_snapshot import snapshot

profile = json.loads(
    (pathlib.Path(__file__).resolve().parents[2] / "config/deployment.json").read_text()
)
p = argparse.ArgumentParser()
p.add_argument("--connection", default=profile["CLI_CONNECTION"])
p.add_argument("--deploy", action="store_true")
a = p.parse_args()
os.chdir(ROOT)


def output(args):
    return run(args, capture_output=True).stdout.strip()


if output(["git", "status", "--porcelain"]):
    raise SystemExit("Commit or remove untracked changes before release")
commit = output(["git", "rev-parse", "HEAD"])
# Source-only checks are not repeated when GitHub passed them on these exact files.
run(["python3", "scripts/release/check.py", "--reuse-hosted-run"])
run(["python3", "scripts/release/migrations.py", "check"])
if not a.deploy:
    print("Checks passed; no deployment requested. Use --deploy to publish.")
    raise SystemExit
run(["python3", "scripts/verify-backup.py"])
release = (
    ROOT / ".release" / datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
)
release.mkdir(parents=True, mode=0o700)
record = {"commit": commit, "state": "prepared", "connection": a.connection}


def save():
    (release / "release.json").write_text(json.dumps(record, indent=2) + "\n")


def describe():
    return json.loads(
        output(
            [
                "snow",
                "sql",
                "--connection",
                a.connection,
                "-q",
                "DESCRIBE APPLICATION SERVICE "
                + ".".join(profile[key] for key in ("DATABASE", "APP_SCHEMA", "APP_SERVICE")),
                "--format",
                "json",
            ]
        )
    )


record["before"] = describe()
save()
# Recheck after the long verification; do not deploy edits made during tests.
if output(["git", "status", "--porcelain"]) or output(["git", "rev-parse", "HEAD"]) != commit:
    raise SystemExit("Source changed during checks")
source, record["source_sha256"] = snapshot(ROOT, commit, release)
try:
    record["state"] = "deploying"
    save()
    with (release / "deploy.log").open("w") as log:
        run(["snow", "app", "deploy", "--connection", a.connection], cwd=source, stdout=log, stderr=log)
    record["after"] = describe()
    if (
        not record["after"]
        or record["after"][0].get("status") != "RUNNING"
        or record["after"][0].get("is_upgrading") == "true"
    ):
        raise RuntimeError("Runtime is not ready")
    record["state"] = "deployed-needs-verification"
    save()
    run(["node", "scripts/release/postcheck.mjs"])
    record["state"] = "public-checks-passed-awaiting-signed-in-check"
    save()
    print(
        "Deployed. Complete the signed-in checklist in docs/SAFE-RELEASES.md. Evidence: "
        + str(release)
    )
except Exception:
    record["state"] = "failed-requires-review"
    save()
    raise
