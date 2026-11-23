"""Scan the exact built image (OS and installed language packages), retain an SBOM.

Fixable and unreviewed unfixed HIGH/CRITICAL findings block release. Reviewed
residual findings stay visible; an exception is not a vulnerability fix.
"""

import datetime
import fcntl
import json
import pathlib
import re
import subprocess
from advisory_reviews import ROOT, disposition, load_reviews

SCANNER = (
    "aquasec/trivy:0.76.2@sha256:8f6bb947dbc528902e11f2f5be52f7b519f6a39d5d148f41166f2040499768fb"
)


def summarize(report, *, reviews=None, scope=None):
    reviews = reviews or {}
    findings = {}
    for result in report.get("Results", []):
        for item in result.get("Vulnerabilities", []):
            key = (
                result.get("Class"),
                item["PkgName"],
                item["InstalledVersion"],
                item["VulnerabilityID"],
            )
            findings[key] = {
                "class": result.get("Class"),
                "package": item["PkgName"],
                "version": item["InstalledVersion"],
                "id": item["VulnerabilityID"],
                "severity": item["Severity"],
                "fixedVersion": item.get("FixedVersion") or None,
                "status": item.get("Status"),
                "url": item.get("PrimaryURL"),
                "reachability": "not assessed by package scan",
            }
    values = list(findings.values())
    for finding in values:
        finding["review"] = disposition(reviews, scope, finding) if scope else None
        finding["blocking"] = finding["severity"] in ("HIGH", "CRITICAL") and bool(
            finding["fixedVersion"] or not finding["review"]
        )
    high = [v for v in values if v["severity"] in ("HIGH", "CRITICAL")]
    return {
        "distinctPackageAdvisories": len(values),
        "distinctAdvisories": len({v["id"] for v in values}),
        "affectedPackages": len({v["package"] for v in values}),
        "blocking": [v for v in high if v["blocking"]],
        "fixableHighCritical": [v for v in high if v["fixedVersion"]],
        "unreviewedUnfixedHighCritical": [v for v in high if not v["fixedVersion"] and not v["review"]],
        "reviewedUnfixedHighCritical": [v for v in high if not v["fixedVersion"] and v["review"]],
        "unfixedHighCritical": [v for v in high if not v["fixedVersion"]],
        "findings": values,
    }


def package_version(package):
    # Trivy separates Debian epoch/revision; dpkg records the full version.
    version = package["Version"]
    if package.get("Release"):
        version += "-" + package["Release"]
    if package.get("Epoch"):
        version = str(package["Epoch"]) + ":" + version
    return version


def scope_donor_report(report, inventory):
    # Compare exact donor package versions, not merely names. A library replaced
    # by apt in the final stage was already removed by its byte-hash check.
    retained = {
        (f["package"]["name"], f["package"]["version"]) for f in inventory["files"] if f["package"]
    }
    reported = {
        (p["Name"], package_version(p))
        for r in report.get("Results", [])
        for p in r.get("Packages", [])
    }
    missing = retained - reported
    if missing:
        raise ValueError(f"Donor scanner omitted copied packages: {sorted(missing)}")
    scoped = {**report, "Results": []}
    for result in report.get("Results", []):
        scoped["Results"].append(
            {
                **result,
                "Vulnerabilities": [
                    v
                    for v in result.get("Vulnerabilities", [])
                    if (v["PkgName"], v["InstalledVersion"]) in retained
                ],
            }
        )
    return scoped


def scan_native_donor(image_id, directory, *, reviews=None, scope=None):
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
                "/bin/cat",
                image_id,
                "/worker/native-inventory.json",
            ],
            text=True,
        )
    )
    donor = inventory["donorImage"]
    if not re.fullmatch(r"[A-Za-z0-9._/:-]+@sha256:[a-f0-9]{64}", donor):
        raise ValueError("Expected pinned donor image")
    (directory / "native-inventory.json").write_text(json.dumps(inventory, indent=2) + "\n")
    base = [
        "docker",
        "run",
        "--rm",
        "-v",
        f"{directory}:/reports",
        "-v",
        "stillmark-trivy-cache:/root/.cache/trivy",
        SCANNER,
        "image",
        "--skip-version-check",
        "--image-src",
        "remote",
        "--platform",
        "linux/amd64",
    ]
    subprocess.run(
        [
            *base,
            "--scanners",
            "vuln",
            "--list-all-pkgs",
            "--format",
            "json",
            "--output",
            "/reports/native-donor.json",
            donor,
        ],
        check=True,
    )
    subprocess.run(
        [*base, "--format", "cyclonedx", "--output", "/reports/native-donor.cdx.json", donor],
        check=True,
    )
    report = json.loads((directory / "native-donor.json").read_text())
    scoped = scope_donor_report(report, inventory)
    result = {
        "donorImage": donor,
        "runtimeImage": image_id,
        "unattributedFiles": [f["path"] for f in inventory["files"] if not f["package"]],
        "limitation": "Package advisory matching does not prove reachability or identify every vulnerability in custom vendor binaries.",
        **summarize(scoped, reviews=reviews, scope=scope),
    }
    (directory / "native-summary.json").write_text(json.dumps(result, indent=2) + "\n")
    return result


def scan_image(image, directory, *, require_native=False, review_scope=None):
    # Trivy's filesystem cache is exclusive. Separate verification processes
    # share the cache safely instead of failing intermittently on its lock.
    lock_path = pathlib.Path.home() / ".cache" / "stillmark" / "trivy-scan.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        return _scan_image(image, directory, require_native=require_native, review_scope=review_scope)


def _scan_image(image, directory, *, require_native=False, review_scope=None):
    reviews = load_reviews(ROOT / "config/package-advisory-reviews.json")
    directory = pathlib.Path(directory).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    inspection = json.loads(
        subprocess.check_output(["docker", "image", "inspect", image], text=True)
    )[0]
    # Docker serializes an unlabeled image as either null or an empty object.
    labels = (inspection.get("Config") or {}).get("Labels") or {}
    if not isinstance(labels, dict):
        raise ValueError("Expected Docker image labels to be an object or null")
    native_marker = labels.get("org.stillmark.native-security")
    if require_native and native_marker != "reviewed-source-v1":
        raise ValueError("Video image requires the reviewed native security inventory and scan")
    image_id = inspection["Id"]
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", image_id):
        raise ValueError("Expected immutable local image ID")
    base = [
        "docker",
        "run",
        "--rm",
        "-v",
        "/var/run/docker.sock:/var/run/docker.sock",
        "-v",
        f"{directory}:/reports",
        "-v",
        "stillmark-trivy-cache:/root/.cache/trivy",
        SCANNER,
    ]
    subprocess.run(
        [
            *base,
            "image",
            "--skip-version-check",
            "--scanners",
            "vuln",
            "--format",
            "json",
            "--output",
            "/reports/vulnerabilities.json",
            image_id,
        ],
        check=True,
    )
    subprocess.run(
        [
            *base,
            "image",
            "--skip-version-check",
            "--format",
            "cyclonedx",
            "--output",
            "/reports/sbom.cdx.json",
            image_id,
        ],
        check=True,
    )
    report = json.loads((directory / "vulnerabilities.json").read_text())
    if report.get("Metadata", {}).get("ImageID") != image_id:
        raise ValueError("Scanner did not report the requested immutable image")
    result = {
        "imageId": image_id,
        "reference": image,
        "scanner": SCANNER,
        "scannedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        **summarize(report, reviews=reviews, scope=review_scope),
    }
    if native_marker:
        from native_security import scan_native_components

        result["nativeComponents"] = scan_native_components(
            image_id, directory, pathlib.Path(__file__).resolve().parents[2]
        )
    if labels.get("org.stillmark.native-donor-inventory"):
        result["nativeDonor"] = scan_native_donor(image_id, directory, reviews=reviews, scope=f"{review_scope}:native-donor" if review_scope else None)
    (directory / "summary.json").write_text(json.dumps(result, indent=2) + "\n")
    print(
        f"Image security: {image_id}: {len(result['blocking'])} blocking HIGH/CRITICAL, "
        f"{len(result['unfixedHighCritical'])} unfixed HIGH/CRITICAL package/advisory pairs. Evidence: {directory}"
    )
    if (
        result["blocking"]
        or result.get("nativeDonor", {}).get("blocking")
        or result.get("nativeComponents", {}).get("blocking")
    ):
        raise RuntimeError(
            "Fixable or unreviewed HIGH/CRITICAL vulnerabilities block release; see summary.json"
        )
    return result


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    scan_image(args.image, args.output)
