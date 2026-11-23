"""The deployed-image check reports on the image that is running, not on a fresh build."""

import datetime
import hashlib
import json
import pathlib
import tempfile
import unittest

import deployed_images
from image_security import summarize

DEPLOYED = "sha256:" + "a" * 64
REBUILT = "sha256:" + "b" * 64
OPENSSL = {
    "PkgName": "libssl3",
    "InstalledVersion": "3.0.1-1",
    "VulnerabilityID": "CVE-2026-0001",
    "Severity": "HIGH",
}


def report(*vulnerabilities, packages=("libssl3", "zlib1g")):
    return {
        "Results": [
            {
                "Class": "os-pkgs",
                "Packages": [{"Name": name} for name in packages],
                "Vulnerabilities": list(vulnerabilities),
            }
        ]
    }


def review_of(finding, worker="upload-cpu"):
    today = datetime.datetime.now(datetime.timezone.utc).date()
    key = (worker, "os-pkgs", finding["PkgName"], finding["InstalledVersion"], finding["VulnerabilityID"])
    return {
        key: {
            "severity": finding["Severity"],
            "reviewedAt": today.isoformat(),
            "expiresAt": (today + datetime.timedelta(days=30)).isoformat(),
            "sourceBindings": {},
        }
    }


class DeployedImages(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temporary.name)
        self.scanned = []
        for folder in ("config", "workers/upload-cpu", "security/deployed-images"):
            (self.root / folder).mkdir(parents=True)
        self.pin("upload-cpu", DEPLOYED)
        for worker in ("face-cpu", "search-cpu", "video-gpu"):
            self.pin(worker, DEPLOYED)
        for worker in deployed_images.pinned_images(self.root):
            self.record(worker, DEPLOYED)

    def tearDown(self):
        self.temporary.cleanup()

    def pin(self, worker, digest):
        """Point the repository's deployment pin for one worker at a digest."""
        reference = f"/repository/{worker}:release@{digest}"
        config = self.root / "config"
        deployment_path = config / "deployment.json"
        deployment = json.loads(deployment_path.read_text()) if deployment_path.is_file() else {}
        if worker == "upload-cpu":
            (self.root / "workers/upload-cpu/settings.json").write_text(json.dumps({"image": reference}))
        elif worker == "search-cpu":
            (config / "search-worker-spec.json").write_text(
                json.dumps({"spec": {"containers": [{"image": reference}]}})
            )
        else:
            deployment["FACE_IMAGE" if worker == "face-cpu" else "GPU_IMAGE"] = reference
        deployment_path.write_text(json.dumps(deployment))

    def record(self, worker, digest):
        """Store an inventory describing `digest` as the recorded one for a worker."""
        path = self.root / deployed_images.INVENTORY_DIR / f"{worker}.cdx.json"
        path.write_text(json.dumps({"metadata": {"component": {"name": digest}}}))
        manifest_path = self.root / deployed_images.INVENTORY_DIR / "manifest.json"
        manifest = json.loads(manifest_path.read_text()) if manifest_path.is_file() else {"images": {}}
        manifest["images"][worker] = {
            "digest": digest,
            "inventory": path.name,
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        }
        manifest_path.write_text(json.dumps(manifest))

    def check(self, findings, reviews=None):
        def scan(path, _directory):
            self.scanned.append(path.name)
            return report(*findings.get(path.name, []))

        results = deployed_images.check(
            self.root, scan=scan, reviews=reviews or {}, directory=self.root / "out"
        )
        return {result["worker"]: result for result in results}

    def test_clean_inventories_pass_and_name_the_deployed_digest(self):
        results = self.check({})
        self.assertFalse(deployed_images.failed(results.values()))
        for result in results.values():
            self.assertTrue(result["matchesDeployed"])
            self.assertEqual(result["scannedDigest"], result["deployedDigest"])
        self.assertEqual(len(self.scanned), 4)

    def test_an_advisory_fixed_after_deployment_blocks_although_a_rebuild_is_clean(self):
        # At release the advisory had no fix and was reviewed, so the image shipped.
        accepted = review_of(OPENSSL)
        at_release = self.check({"upload-cpu.cdx.json": [OPENSSL]}, accepted)
        self.assertFalse(deployed_images.failed(at_release.values()))
        self.assertEqual(len(at_release["upload-cpu"]["reviewedUnfixedHighCritical"]), 1)

        # Later the distribution publishes a fix. A build from current source installs it,
        # so the image the source-build gate scans has nothing to report.
        fixed = {**OPENSSL, "FixedVersion": "3.0.1-2"}
        rebuilt = summarize(report(), reviews=accepted, scope="upload-cpu")
        self.assertEqual(rebuilt["blocking"], [])

        # The running image still has the old package: the deployed check fails and says so.
        now = self.check({"upload-cpu.cdx.json": [fixed]}, accepted)
        self.assertTrue(deployed_images.failed(now.values()))
        blocking = now["upload-cpu"]["blocking"]
        self.assertEqual([finding["id"] for finding in blocking], ["CVE-2026-0001"])
        self.assertEqual(now["upload-cpu"]["scannedDigest"], DEPLOYED)
        text = deployed_images.describe(now["upload-cpu"])
        self.assertIn(DEPLOYED, text)
        self.assertIn("fixed in 3.0.1-2; the deployed image still has 3.0.1-1", text)

    def test_a_scan_that_evaluated_no_packages_is_not_a_pass(self):
        results = deployed_images.check(
            self.root, scan=lambda *_: report(packages=()), reviews={}, directory=self.root / "out"
        )
        self.assertTrue(deployed_images.failed(results))
        self.assertIn("evaluated no packages", results[0]["problems"][0])
        self.assertIn("NOT CHECKED", deployed_images.describe(results[0]))

    def test_a_new_advisory_without_a_review_blocks(self):
        results = self.check({"face-cpu.cdx.json": [OPENSSL]})
        self.assertTrue(deployed_images.failed(results.values()))
        self.assertIn("no fix and no current review", deployed_images.describe(results["face-cpu"]))

    def test_a_review_for_another_worker_does_not_cover_this_one(self):
        results = self.check({"face-cpu.cdx.json": [OPENSSL]}, review_of(OPENSSL, "upload-cpu"))
        self.assertEqual(len(results["face-cpu"]["blocking"]), 1)

    def test_a_new_pin_without_its_inventory_fails_and_is_not_reported_as_scanned(self):
        self.pin("video-gpu", REBUILT)
        results = self.check({})
        self.assertTrue(deployed_images.failed(results.values()))
        video = results["video-gpu"]
        self.assertFalse(video["matchesDeployed"])
        self.assertNotIn("scannedDigest", video)
        self.assertIn(f"but the deployed image is {REBUILT}", video["problems"][0])
        self.assertNotIn("video-gpu.cdx.json", self.scanned)
        self.assertIn("NOT CHECKED", deployed_images.describe(video))

    def test_a_missing_inventory_fails(self):
        manifest_path = self.root / deployed_images.INVENTORY_DIR / "manifest.json"
        manifest = json.loads(manifest_path.read_text())
        del manifest["images"]["search-cpu"]
        manifest_path.write_text(json.dumps(manifest))
        results = self.check({})
        self.assertIn("no inventory is recorded", results["search-cpu"]["problems"][0])
        self.assertTrue(deployed_images.failed(results.values()))

    def test_an_altered_inventory_file_fails(self):
        path = self.root / deployed_images.INVENTORY_DIR / "face-cpu.cdx.json"
        path.write_text(path.read_text() + " ")
        results = self.check({})
        self.assertIn("is not the recorded file", results["face-cpu"]["problems"][0])

    def test_an_inventory_of_another_image_cannot_stand_in(self):
        # The manifest claims the deployed digest, but the file describes a different image.
        path = self.root / deployed_images.INVENTORY_DIR / "face-cpu.cdx.json"
        path.write_text(json.dumps({"metadata": {"component": {"name": REBUILT}}}))
        manifest_path = self.root / deployed_images.INVENTORY_DIR / "manifest.json"
        manifest = json.loads(manifest_path.read_text())
        manifest["images"]["face-cpu"]["sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
        manifest_path.write_text(json.dumps(manifest))
        results = self.check({})
        self.assertIn(f"describes {REBUILT}, not {DEPLOYED}", results["face-cpu"]["problems"][0])

    def test_an_image_pinned_by_tag_only_is_refused(self):
        with self.assertRaises(ValueError):
            deployed_images.digest_of("/repository/upload-worker:latest")

    def test_the_repository_records_an_inventory_for_every_pinned_image(self):
        manifest = deployed_images.load_manifest()["images"]
        for worker, reference in deployed_images.pinned_images().items():
            self.assertEqual(deployed_images.inventory_problems(worker, reference, manifest.get(worker)), [])


if __name__ == "__main__":
    unittest.main()
