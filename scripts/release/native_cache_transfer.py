"""Transfer only an authoritative CI native build cache, never application code.

A successful run from this repository/workflow and an ancestor source commit is
required. Docker still rechecks the exact platform/toolchain and all file hashes
when restoring; a different toolchain builds from public source instead.
"""

import argparse
import hashlib
import json
import os
import pathlib
import re
import subprocess
import tempfile
from urllib.parse import urlencode

ROOT = pathlib.Path(__file__).resolve().parents[2]
NATIVE = ROOT / "workers/video-gpu/native"
RECIPE = ROOT / "workers/video-gpu/Dockerfile"
BASE = "ubuntu:24.04@sha256:9c7f200c07e3d4a03e7249d2c16bf66a51120fb876aa2242cf31451412543289"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def command(args):
    return subprocess.check_output(args, cwd=ROOT, text=True, timeout=120).strip()


def validate_export(directory, expected_commit, repository, run_id):
    receipt = json.loads((directory / "receipt.json").read_text())
    if (
        receipt.get("commit") != expected_commit
        or receipt.get("repository") != repository
        or str(receipt.get("runId")) != str(run_id)
    ):
        raise ValueError("Cache receipt does not match the authenticated CI run")
    entries = [p for p in directory.iterdir() if p.is_dir()]
    if len(entries) != 1 or not re.fullmatch(r"[a-f0-9]{64}", entries[0].name):
        raise ValueError("Expected one source-bound native cache entry")
    entry = entries[0]
    if entry.is_symlink() or any(p.is_symlink() for p in entry.iterdir()):
        raise ValueError("Cache export must contain regular files, not links")
    manifest = json.loads((entry / "manifest.json").read_text())
    identity = manifest["identity"]
    key = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
    if key != entry.name or digest(entry / "runtime.tar.gz") != manifest["archiveSHA256"]:
        raise ValueError("Cache identity or archive digest mismatch")
    if identity.get("recipeSHA256") != digest(RECIPE):
        raise ValueError("Cache compiler recipe differs from this checkout")
    expected_names = set(json.loads((NATIVE / "build-inputs.json").read_text())["files"])
    if set(identity["inputs"]) != expected_names:
        raise ValueError("Cache native input inventory differs from this checkout")
    for name, expected in identity["inputs"].items():
        if pathlib.Path(name).name != name or digest(NATIVE / name) != expected:
            raise ValueError("Cache source input differs: " + name)
    files = {
        str(p.relative_to(directory)): digest(p) for p in sorted(entry.iterdir()) if p.is_file()
    }
    if set(files) != {
        entry.name + "/manifest.json",
        entry.name + "/runtime.tar.gz",
    } or files != receipt.get("files"):
        raise ValueError("Cache export receipt digest mismatch")
    return entry


def write_receipt(directory):
    commit = command(["git", "rev-parse", "HEAD"])
    if os.environ.get("GITHUB_SHA") != commit:
        raise ValueError("Receipt requires the exact CI checkout commit")
    files = {
        str(p.relative_to(directory)): digest(p)
        for p in sorted(directory.rglob("*"))
        if p.is_file() and p.name != "receipt.json"
    }
    receipt = {
        "commit": commit,
        "repository": os.environ["GITHUB_REPOSITORY"],
        "runId": os.environ["GITHUB_RUN_ID"],
        "files": files,
    }
    (directory / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    validate_export(directory, commit, receipt["repository"], receipt["runId"])


def validate_run(run, commit, repository):
    if (
        run.get("head_sha") != commit
        or run.get("status") != "completed"
        or run.get("conclusion") != "success"
        or run.get("path") != "docs/reference/github-quality-workflow.yml"
        or run.get("repository", {}).get("full_name") != repository
    ):
        raise ValueError(
            "Native cache requires a successful exact-source quality workflow in this repository"
        )


def export_cache(directory):
    from video_image import prepare_context

    with tempfile.TemporaryDirectory(prefix="stillmark-native-export-") as scratch:
        context = pathlib.Path(scratch) / "source"
        prepare_context(ROOT, "HEAD", context)
        subprocess.run(
            [
                "docker",
                "build",
                "--platform",
                "linux/amd64",
                "--target",
                "native-cache-export",
                "--output",
                "type=local,dest=" + str(directory.resolve()),
                "-f",
                str(context / "workers/video-gpu/Dockerfile"),
                str(context),
            ],
            check=True,
        )


def repository_info():
    repository = os.environ.get("GITHUB_REPOSITORY") or command(
        ["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]
    )
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        raise ValueError("Invalid GitHub repository identity")
    info = json.loads(command(["gh", "api", f"repos/{repository}"]))
    if info.get("full_name") != repository or not info.get("default_branch"):
        raise ValueError("Authenticated repository identity mismatch")
    return repository, info["default_branch"]


def is_ancestor(commit):
    if not re.fullmatch(r"[a-f0-9]{40}", commit):
        raise ValueError("Invalid cache source commit")
    # A successful run may refer to a branch that was subsequently force-pushed.
    exists = subprocess.run(
        ["git", "cat-file", "-e", commit + "^{commit}"], cwd=ROOT,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    if exists.returncode:
        return False
    result = subprocess.run(["git", "merge-base", "--is-ancestor", commit, "HEAD"], cwd=ROOT)
    if result.returncode not in (0, 1):
        raise ValueError("Could not establish cache source ancestry")
    return result.returncode == 0


def compatible_inputs(commit):
    names = json.loads((NATIVE / "build-inputs.json").read_text())["files"]
    if not names or len(names) != len(set(names)) or any(pathlib.Path(n).name != n for n in names):
        raise ValueError("Invalid native build input inventory")
    # Only the native recipe/inputs are compared, never application source or SOURCE_COMMIT.
    paths = [RECIPE, *(NATIVE / name for name in names)]
    for path in paths:
        relative = path.relative_to(ROOT).as_posix()
        result = subprocess.run(
            ["git", "show", commit + ":" + relative], cwd=ROOT, capture_output=True,
        )
        if result.returncode or hashlib.sha256(result.stdout).hexdigest() != digest(path):
            return False
    return True


def available_artifact(repository, run_id, commit):
    listing = json.loads(command([
        "gh", "api", f"repos/{repository}/actions/runs/{run_id}/artifacts?per_page=100"
    ]))
    artifacts = [a for a in listing["artifacts"]
                 if a["name"] == "video-native-cache-" + commit and not a.get("expired")]
    if len(artifacts) > 1:
        raise ValueError("Ambiguous native cache artifact")
    return artifacts[0] if artifacts else None


def restore_latest():
    repository, branch = repository_info()
    query = urlencode({"branch": branch, "status": "success", "per_page": 100})
    listing = json.loads(command([
        "gh", "api", f"repos/{repository}/actions/workflows/quality.yml/runs?{query}"
    ]))
    checked = 0
    for run in listing["workflow_runs"]:
        # Successful default-branch pushes/manual runs only; never PR artifacts.
        if (run.get("event") not in ("push", "workflow_dispatch")
                or run.get("head_branch") != branch
                or run.get("status") != "completed" or run.get("conclusion") != "success"):
            continue
        commit = run.get("head_sha", "")
        validate_run(run, commit, repository)
        if run.get("head_repository", {}).get("full_name") != repository:
            raise ValueError("Native cache head repository is untrusted")
        if not isinstance(run.get("id"), int) or isinstance(run["id"], bool) or run["id"] <= 0:
            raise ValueError("Invalid native cache run identity")
        checked += 1
        if not is_ancestor(commit) or not compatible_inputs(commit):
            continue
        if import_run(run["id"], commit, allow_missing=True, repository=repository):
            result = {"imported": True, "runId": run["id"], "commit": commit,
                      "candidatesChecked": checked, "repository": repository}
            break
    else:
        result = {"imported": False, "coldBuild": True, "candidatesChecked": checked,
                  "repository": repository, "reason": "No available compatible trusted ancestor cache"}
    output = ROOT / ".release/native-cache-import/selection.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result))
    return result


def import_run(run_id, source_commit, *, allow_missing=False, repository=None):
    commit = command(["git", "rev-parse", source_commit + "^{commit}"])
    subprocess.run(["git", "merge-base", "--is-ancestor", commit, "HEAD"], cwd=ROOT, check=True)
    repository = repository or command(
        ["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]
    )
    run = json.loads(command(["gh", "api", f"repos/{repository}/actions/runs/{run_id}"]))
    validate_run(run, commit, repository)
    artifact_name = "video-native-cache-" + commit
    artifact = available_artifact(repository, run_id, commit)
    if artifact is None:
        if allow_missing:
            return False
        raise ValueError("Expected one unexpired native cache artifact")
    with tempfile.TemporaryDirectory(prefix="stillmark-native-cache-") as scratch:
        directory = pathlib.Path(scratch)
        download = subprocess.run(
            [
                "gh",
                "run",
                "download",
                str(run_id),
                "--repo",
                repository,
                "--name",
                artifact_name,
                "--dir",
                str(directory),
            ],
            cwd=ROOT,
            timeout=600,
        )
        if download.returncode:
            # Expiry/deletion between listing and download is a cache miss, but
            # authentication/network failures or a still-present artifact fail closed.
            if allow_missing and available_artifact(repository, run_id, commit) is None:
                return False
            download.check_returncode()
        entry = validate_export(directory, commit, repository, run_id)
        dockerfile = directory / "seed.Dockerfile"
        dockerfile.write_text(
            f"# syntax=docker/dockerfile:1.7\nFROM {BASE}\nCOPY {entry.name}/ /import/\nRUN --mount=type=cache,id=stillmark-video-native-v1,target=/native-cache,sharing=locked mkdir -p /native-cache/{entry.name} && cp /import/manifest.json /import/runtime.tar.gz /native-cache/{entry.name}/\n"
        )
        subprocess.run(
            ["docker", "build", "--platform", "linux/amd64", "-f", str(dockerfile), str(directory)],
            check=True,
        )
        evidence = ROOT / ".release/native-cache-import" / str(run_id)
        evidence.mkdir(parents=True, exist_ok=True)
        (evidence / "receipt.json").write_bytes((directory / "receipt.json").read_bytes())
        (evidence / "github-run.json").write_text(
            json.dumps(
                {
                    "id": run["id"],
                    "head_sha": run["head_sha"],
                    "path": run["path"],
                    "conclusion": run["conclusion"],
                    "repository": repository,
                    "artifact": artifact,
                },
                indent=2,
            )
            + "\n"
        )
    print(
        "Imported source-bound native cache; final image restore, scans and tests remain required."
    )
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_mutually_exclusive_group(required=True)
    actions.add_argument("--write-receipt", type=pathlib.Path)
    actions.add_argument("--export-cache", type=pathlib.Path)
    actions.add_argument("--import-run", type=int)
    actions.add_argument("--restore-latest", action="store_true")
    parser.add_argument("--source-commit", default="HEAD")
    args = parser.parse_args()
    if args.export_cache:
        export_cache(args.export_cache)
    elif args.write_receipt:
        write_receipt(args.write_receipt.resolve())
    elif args.restore_latest:
        restore_latest()
    else:
        import_run(args.import_run, args.source_commit)


if __name__ == "__main__":
    main()
