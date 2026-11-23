"""Rescan the software inventories of the exact deployed images against today's advisories.

`check_worker_images.py` builds each worker image from current source and scans what it
built. A build installs the operating-system updates available that day, so it proves the
source still builds into a clean image. It says nothing about the image that is running:
that one was built earlier and keeps the packages it was built with.

This check covers the running images. When an image is released, its software inventory
(the CycloneDX SBOM the release scan produced for that image) is recorded in
`security/deployed-images/` together with the image digest. `check` then:

  1. requires a recorded inventory for every pinned worker image, for exactly the pinned
     digest (a pin without a matching inventory fails);
  2. requires each inventory file to be the recorded bytes and to describe that digest;
  3. matches each inventory against the current vulnerability database;
  4. applies the same policy as a release: a HIGH or CRITICAL advisory blocks when a fix
     exists or when it has no current review.

Every result names the digest it is about. Limits:

  - "Deployed" means pinned in this repository; the running services are not queried.
  - An inventory lists packages the scanner recognised when the image was built; files
    it could not attribute to a package are not in it.
  - The inventory and its checksum are both kept here. They guard against accident, not
    against someone who edits both; `record` is the only link to the real image.
  - A review is bound to current source. When source changes, the release gate forces
    every review to be redone, and the redone review then also covers the older
    deployed image until that image is rebuilt.
  - The natively compiled components of the video image are pinned source versions, so
    the source build already rescans exactly what is deployed.

  python3 scripts/release/deployed_images.py check
  python3 scripts/release/deployed_images.py record <worker> <local image ID or reference>
"""

import argparse
import datetime
import hashlib
import json
import pathlib
import re
import subprocess
import sys
import uuid

from advisory_reviews import ROOT, load_reviews
from image_security import SCANNER, summarize

INVENTORY_DIR = pathlib.Path("security/deployed-images")
DIGEST = re.compile(r"sha256:[a-f0-9]{64}")


def pinned_images(root=ROOT):
    """The image reference each worker is deployed from, as pinned in the repository."""
    deployment = json.loads((root / "config/deployment.json").read_text())
    upload = json.loads((root / "workers/upload-cpu/settings.json").read_text())
    search = json.loads((root / "config/search-worker-spec.json").read_text())
    return {
        "upload-cpu": upload["image"],
        "face-cpu": deployment["FACE_IMAGE"],
        "search-cpu": search["spec"]["containers"][0]["image"],
        "video-gpu": deployment["GPU_IMAGE"],
    }


def digest_of(reference):
    name, separator, digest = reference.rpartition("@")
    if not separator or not DIGEST.fullmatch(digest):
        raise ValueError(f"Image is not pinned by digest: {reference}")
    return digest


def load_manifest(root=ROOT):
    path = root / INVENTORY_DIR / "manifest.json"
    return json.loads(path.read_text()) if path.is_file() else {"images": {}}


def inventory_problems(worker, reference, entry, root=ROOT):
    """Why the recorded inventory cannot stand for the pinned image; empty when it can."""
    digest = digest_of(reference)
    if not entry:
        return [f"{worker}: no inventory is recorded for the deployed image {digest}"]
    if entry.get("digest") != digest:
        return [
            f"{worker}: the recorded inventory is for {entry.get('digest')}, "
            f"but the deployed image is {digest}"
        ]
    name = entry.get("inventory", "")
    path = (root / INVENTORY_DIR / name).resolve()
    if not re.fullmatch(r"[a-z0-9-]+\.cdx\.json", name) or not path.is_file():
        return [f"{worker}: inventory file is missing: {name}"]
    data = path.read_bytes()
    if hashlib.sha256(data).hexdigest() != entry.get("sha256"):
        return [f"{worker}: inventory file {name} is not the recorded file"]
    subject = json.loads(data).get("metadata", {}).get("component", {}).get("name")
    if subject != digest:
        return [f"{worker}: inventory file {name} describes {subject}, not {digest}"]
    return []


def scan_inventory(path, directory):
    """Match one CycloneDX inventory against the current vulnerability database."""
    directory.mkdir(parents=True, exist_ok=True)
    output = f"{path.name}.vulnerabilities.json"
    subprocess.run(
        [
            "docker",
            "run",
            "--rm",
            "-v",
            f"{path.resolve().parent}:/inventories:ro",
            "-v",
            f"{directory.resolve()}:/reports",
            "-v",
            "stillmark-trivy-cache:/root/.cache/trivy",
            SCANNER,
            "sbom",
            "--skip-version-check",
            "--scanners",
            "vuln",
            "--list-all-pkgs",
            "--format",
            "json",
            "--output",
            f"/reports/{output}",
            f"/inventories/{path.name}",
        ],
        check=True,
    )
    return json.loads((directory / output).read_text())


def packages_evaluated(report):
    """How many packages the scanner actually matched against advisories."""
    return sum(len(result.get("Packages") or []) for result in report.get("Results", []))


def check(root=ROOT, *, scan=scan_inventory, reviews=None, directory=None):
    """One result per pinned worker image. A result with problems or blocking findings fails."""
    reviews = load_reviews(root / "config/package-advisory-reviews.json") if reviews is None else reviews
    directory = directory or root / ".release" / "deployed-images" / str(uuid.uuid4())
    manifest = load_manifest(root)["images"]
    results = []
    for worker, reference in pinned_images(root).items():
        entry = manifest.get(worker)
        result = {"worker": worker, "deployedReference": reference, "deployedDigest": digest_of(reference)}
        problems = inventory_problems(worker, reference, entry, root)
        if problems:
            # Nothing can be said about the running image: that is a failure, not a pass.
            result.update(matchesDeployed=False, problems=problems, blocking=[])
        else:
            report = scan(root / INVENTORY_DIR / entry["inventory"], directory)
            evaluated = packages_evaluated(report)
            # A scan that looked at no packages found nothing because it checked nothing.
            result.update(
                matchesDeployed=True,
                problems=[] if evaluated else [f"{worker}: the scan evaluated no packages from {entry['inventory']}"],
                packagesEvaluated=evaluated,
                scannedDigest=entry["digest"],
                inventory=entry["inventory"],
                scanner=SCANNER,
                scannedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                **summarize(report, reviews=reviews, scope=worker),
            )
        results.append(result)
    return results


def failed(results):
    return any(result["problems"] or result["blocking"] for result in results)


def describe(result):
    if result["problems"]:
        return "\n".join("  NOT CHECKED " + problem for problem in result["problems"])
    lines = [
        f"  {result['worker']} {result['scannedDigest']} (the deployed image): "
        f"{len(result['blocking'])} blocking, "
        f"{len(result['reviewedUnfixedHighCritical'])} reviewed without a fix"
    ]
    for finding in result["blocking"]:
        reason = (
            f"fixed in {finding['fixedVersion']}; the deployed image still has {finding['version']}"
            if finding["fixedVersion"]
            else "no fix and no current review"
        )
        lines.append(f"    {finding['severity']} {finding['id']} {finding['package']}: {reason}")
    return "\n".join(lines)


def record(worker, image, root=ROOT):
    """Store the inventory of a local image as the one for the pinned digest of `worker`."""
    reference = pinned_images(root)[worker]
    digest = digest_of(reference)
    image_id = json.loads(subprocess.check_output(["docker", "image", "inspect", image], text=True))[0]["Id"]
    if image_id != digest:
        raise SystemExit(f"{image} is {image_id}; the pinned {worker} image is {digest}")
    directory = root / INVENTORY_DIR
    directory.mkdir(parents=True, exist_ok=True)
    name = f"{worker}.cdx.json"
    subprocess.run(
        [
            "docker",
            "run",
            "--rm",
            "-v",
            "/var/run/docker.sock:/var/run/docker.sock",
            "-v",
            f"{directory.resolve()}:/reports",
            "-v",
            "stillmark-trivy-cache:/root/.cache/trivy",
            SCANNER,
            "image",
            "--skip-version-check",
            "--format",
            "cyclonedx",
            "--output",
            f"/reports/{name}",
            image_id,
        ],
        check=True,
    )
    store(worker, reference, directory / name, root)


def store(worker, reference, inventory, root=ROOT):
    """Write the manifest entry for an inventory file already in the inventory directory."""
    manifest = load_manifest(root)
    entry = {
        "reference": reference,
        "digest": digest_of(reference),
        "inventory": inventory.name,
        "sha256": hashlib.sha256(inventory.read_bytes()).hexdigest(),
    }
    problems = inventory_problems(worker, reference, entry, root)
    if problems:
        raise SystemExit("\n".join(problems))
    manifest["images"][worker] = entry
    manifest["images"] = dict(sorted(manifest["images"].items()))
    (root / INVENTORY_DIR / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Recorded {inventory.name} for {worker} {entry['digest']}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("check")
    recording = commands.add_parser("record")
    recording.add_argument("worker", choices=sorted(pinned_images()))
    recording.add_argument("image")
    arguments = parser.parse_args()
    if arguments.command == "record":
        record(arguments.worker, arguments.image)
        sys.exit(0)
    output = ROOT / ".release" / "deployed-images" / str(uuid.uuid4())
    results = check(directory=output)
    (output / "summary.json").parent.mkdir(parents=True, exist_ok=True)
    (output / "summary.json").write_text(json.dumps(results, indent=2) + "\n")
    print("Deployed images, checked against current advisories:")
    for result in results:
        print(describe(result))
    print(f"Evidence: {output}")
    if failed(results):
        raise SystemExit(
            "A deployed image has a fixable or unreviewed HIGH/CRITICAL advisory, or could "
            "not be checked. Rebuild and release that image, or record its inventory."
        )
