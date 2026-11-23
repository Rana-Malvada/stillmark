"""Retain separate npm runtime and build-tool advisory reports and dispositions."""

import datetime
import hashlib
import json
import pathlib
import subprocess
import uuid

from advisory_reviews import ROOT, disposition, load_reviews

PROJECTS = (".", "cloudflare-gateway", "workers/video-gpu", "scripts/load-test/cloud")


def package_advisories(report, lock):
    if report.get("error") or not isinstance(report.get("vulnerabilities"), dict):
        raise ValueError("npm audit did not return a complete advisory report")
    packages = lock.get("packages", {})
    findings = {}
    for name, vulnerability in report["vulnerabilities"].items():
        for advisory in vulnerability.get("via", []):
            # String entries are dependency edges, not an additional advisory.
            # npm emits the actual advisory under the affected dependency too.
            if isinstance(advisory, str):
                if advisory not in report["vulnerabilities"]:
                    raise ValueError(f"npm audit omitted dependency advisory {advisory}")
                continue
            if not isinstance(advisory, dict) or not advisory.get("source") or not advisory.get("url"):
                raise ValueError(f"Malformed npm advisory for {name}")
            nodes = vulnerability.get("nodes")
            if not isinstance(nodes, list) or not nodes:
                raise ValueError(f"npm audit omitted installed package paths for {name}")
            for node in nodes:
                package = packages.get(node, {})
                version = package.get("version")
                if not isinstance(version, str) or not version:
                    raise ValueError(f"npm audit package absent from lock: {node}")
                key = (name, version, str(advisory["source"]))
                finding = findings.setdefault(key, {
                    "class": "npm", "package": name, "version": version,
                    "id": str(advisory["source"]), "url": advisory["url"],
                    "severity": str(advisory.get("severity", "")).upper(),
                    "title": advisory.get("title"), "affectedRange": advisory.get("range"),
                    "fixAvailable": vulnerability.get("fixAvailable"), "nodes": [],
                    "reachability": "Not established by npm audit; nodes match its package advisory entry",
                })
                if finding["severity"] not in {"INFO", "LOW", "MODERATE", "HIGH", "CRITICAL"}:
                    raise ValueError(f"Invalid advisory severity for {name}")
                finding["nodes"].append(node)
    return list(findings.values())


def classify(full_report, runtime_report, lock, *, scope, reviews):
    runtime = package_advisories(runtime_report, lock)
    runtime_keys = {(f["package"], f["version"], f["id"]) for f in runtime}
    full = package_advisories(full_report, lock)
    build = [f for f in full if (f["package"], f["version"], f["id"]) not in runtime_keys]
    for finding in runtime:
        finding["exposure"] = "production dependency set"
        finding["blocking"] = finding["severity"] in ("HIGH", "CRITICAL")
    for finding in build:
        finding["exposure"] = "build/test dependency set; not a demonstrated runtime exploit"
        finding["review"] = disposition(reviews, scope, finding)
        finding["blocking"] = finding["severity"] in ("HIGH", "CRITICAL") and not finding["review"]
    return {
        "runtimeFindings": runtime,
        "buildFindings": build,
        "blockingRuntime": [f for f in runtime if f["blocking"]],
        "blockingBuild": [f for f in build if f["blocking"]],
        "reviewedBuild": [f for f in build if f["review"]],
    }


def audit(root=ROOT):
    output = root / ".release" / "npm-advisories" / str(uuid.uuid4())
    output.mkdir(parents=True, mode=0o700)
    reviews = load_reviews(root / "config/build-advisory-reviews.json")
    summary = {"checkedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(), "projects": [], "status": "running"}
    try:
        for project in PROJECTS:
            directory = output / ("app" if project == "." else project.replace("/", "-"))
            directory.mkdir()
            lock_path = root / project / "package-lock.json"
            lock_bytes = lock_path.read_bytes()
            reports = {}
            for kind, options in (("runtime", ["--omit=dev"]), ("all-dependencies", ["--include=dev"])):
                result = subprocess.run(
                    ["npm", "--prefix", str(root / project), "audit", "--json", "--audit-level=high", *options],
                    text=True, capture_output=True, timeout=180,
                )
                (directory / f"{kind}.json").write_text(result.stdout)
                (directory / f"{kind}.stderr.log").write_text(result.stderr)
                if result.returncode not in (0, 1):
                    raise RuntimeError(f"npm audit failed for {project}/{kind}; evidence: {directory}")
                reports[kind] = json.loads(result.stdout)
            if lock_path.read_bytes() != lock_bytes:
                raise RuntimeError(f"Lock changed during advisory checks: {project}")
            entry = {
                "project": project,
                "lockSha256": hashlib.sha256(lock_bytes).hexdigest(),
                **classify(reports["all-dependencies"], reports["runtime"], json.loads(lock_bytes), scope=project, reviews=reviews),
            }
            summary["projects"].append(entry)
            (directory / "summary.json").write_text(json.dumps(entry, indent=2) + "\n")
            print(f"npm advisories {project}: {len(entry['blockingRuntime'])} runtime blockers, {len(entry['blockingBuild'])} unreviewed build blockers")
        if any(project["blockingRuntime"] or project["blockingBuild"] for project in summary["projects"]):
            raise RuntimeError("Runtime or unreviewed build HIGH/CRITICAL advisories block release")
        summary["status"] = "passed"
    except BaseException:
        summary["status"] = "failed"
        raise
    finally:
        (output / "result.json").write_text(json.dumps(summary, indent=2) + "\n")
        print(f"npm advisory evidence: {output}")
    return summary


if __name__ == "__main__":
    audit()
