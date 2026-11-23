"""Explicit advisory review for native libraries absent from OS package metadata.

This preserves every scanner result. An applicability decision is valid only for
its exact component version, locked source and reviewed application entrypoints.
"""

import hashlib
import json
import pathlib
import subprocess

GRYPE = "anchore/grype@sha256:661583704a253c0448ed63998b5ea2cd9d5a76ee71eedc4aed439b8ce3e93a1c"
REVIEWED = {"patched", "architecture-excluded", "feature-disabled", "configured-path-excluded"}


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def validate_bindings(inventory, native_dir, root):
    for filename in ("components.cdx.json", "source-lock.json", "applicability.json"):
        if inventory["metadata"].get(filename) != sha256(native_dir / filename):
            raise ValueError(f"Native metadata differs from reviewed source: {filename}")
    policy = json.loads((native_dir / "applicability.json").read_text())
    if not policy.get("sourceBindings"):
        raise ValueError("Native review has no source bindings")
    for relative, expected in policy["sourceBindings"].items():
        candidate = (root / relative).resolve()
        if not candidate.is_relative_to(root.resolve()) or sha256(candidate) != expected:
            raise ValueError(f"Native applicability review is stale: {relative}")
    components = json.loads((native_dir / "components.cdx.json").read_text())["components"]
    versions = {c["name"]: c["version"] for c in components}
    if versions != policy.get("components"):
        raise ValueError("Native component versions lack an exact applicability review")
    shipped = {(f["component"], f["version"]) for f in inventory["files"]}
    if shipped != set(versions.items()):
        raise ValueError("Native component inventory does not match shipped components")
    if inventory["architecture"] != policy["architecture"]:
        raise ValueError("Native review is for a different architecture")
    return policy, versions


def summarize_native(report, policy, versions):
    reviews = {(f["component"], f["version"], f["cve"]): f for f in policy["findings"]}
    findings = {}
    for match in report.get("matches", []):
        artifact, vulnerability = match["artifact"], match["vulnerability"]
        name, version = artifact["name"], artifact["version"]
        if versions.get(name) != version:
            raise ValueError(f"Scanner returned an unbound component: {name} {version}")
        advisory = vulnerability["id"]
        key = (name, version, advisory)
        review = reviews.get(key)
        high = vulnerability["severity"].upper() in ("HIGH", "CRITICAL")
        reviewed = bool(
            review
            and review.get("status") in REVIEWED
            and review.get("reason")
            and review.get("evidence")
        )
        findings[key] = {
            "component": name,
            "version": version,
            "id": advisory,
            "severity": vulnerability["severity"],
            "fix": vulnerability.get("fix"),
            "url": vulnerability.get("dataSource"),
            "applicability": review if reviewed else None,
            "blocking": high and not reviewed,
        }
    values = list(findings.values())
    high = [f for f in values if f["severity"].upper() in ("HIGH", "CRITICAL")]
    return {
        "distinctPackageAdvisories": len(values),
        "distinctAdvisories": len({f["id"] for f in values}),
        "blocking": [f for f in values if f["blocking"]],
        "retainedUnpatchedHighCritical": [
            f for f in high if not f["applicability"] or f["applicability"]["status"] != "patched"
        ],
        "findings": values,
        "limitations": policy["limitations"],
    }


def scan_native_components(image_id, directory, root):
    native_dir = root / "workers/video-gpu/native"
    inventory = json.loads(
        subprocess.check_output(
            [
                "docker",
                "run",
                "--rm",
                "--network",
                "none",
                "--read-only",
                "--entrypoint",
                "/usr/local/bin/node",
                image_id,
                "/worker/native-inventory.cjs",
                "verify",
            ],
            text=True,
        )
    )
    policy, versions = validate_bindings(inventory, native_dir, root)
    with (directory / "native-build-evidence.tar").open("wb") as output:
        subprocess.run(
            [
                "docker",
                "run",
                "--rm",
                "--network",
                "none",
                "--read-only",
                "--entrypoint",
                "/bin/tar",
                image_id,
                "-C",
                "/worker/native-security/build-evidence",
                "-cf",
                "-",
                ".",
            ],
            check=True,
            stdout=output,
        )
    (directory / "native-inventory.json").write_text(json.dumps(inventory, indent=2) + "\n")
    (directory / "native-components.cdx.json").write_bytes(
        (native_dir / "components.cdx.json").read_bytes()
    )
    subprocess.run(
        [
            "docker",
            "run",
            "--rm",
            "-e",
            "GRYPE_CHECK_FOR_APP_UPDATE=false",
            "-e",
            "GRYPE_DB_CACHE_DIR=/scan-cache/db",
            "-v",
            f"{directory}:/reports",
            "-v",
            "stillmark-grype-cache:/scan-cache",
            GRYPE,
            "sbom:/reports/native-components.cdx.json",
            "-o",
            "json",
            "--file",
            "/reports/native-vulnerabilities.json",
        ],
        check=True,
    )
    result = summarize_native(
        json.loads((directory / "native-vulnerabilities.json").read_text()), policy, versions
    )
    result.update(runtimeImage=image_id, scanner=GRYPE)
    (directory / "native-summary.json").write_text(json.dumps(result, indent=2) + "\n")
    return result
