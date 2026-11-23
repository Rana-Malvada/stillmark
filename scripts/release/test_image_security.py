import json
import pathlib
import tempfile
import unittest
from unittest.mock import patch
from image_security import scan_image, summarize, scope_donor_report
from check_worker_images import test_cpu_limit


class ImageSecurityTests(unittest.TestCase):
    def test_worker_cpu_limit_uses_daemon_capacity_without_skipping_suites(self):
        for available, expected in [("1\n", "1"), ("2\n", "2"), ("4\n", "4"), ("32\n", "4")]:
            with self.subTest(available=available), patch(
                "subprocess.check_output", return_value=available
            ) as info:
                self.assertEqual(test_cpu_limit(), expected)
                info.assert_called_once_with(
                    ["docker", "info", "--format", "{{.NCPU}}"], text=True
                )
        for invalid in ("0", "-1", "unknown"):
            with self.subTest(invalid=invalid), patch(
                "subprocess.check_output", return_value=invalid
            ):
                with self.assertRaises(ValueError):
                    test_cpu_limit()

    def test_donor_scan_only_counts_exact_copied_versions_and_checks_inventory(self):
        package = {"name": "libexample", "version": "2:1.0-3+deb13u1"}
        inventory = {"files": [{"package": package}, {"package": None}]}
        matching = {"PkgName": "libexample", "InstalledVersion": "2:1.0-3+deb13u1"}
        report = {
            "Results": [
                {
                    "Packages": [
                        {"Name": "libexample", "Version": "1.0", "Release": "3+deb13u1", "Epoch": 2}
                    ],
                    "Vulnerabilities": [
                        matching,
                        {**matching, "InstalledVersion": "2.0"},
                        {"PkgName": "not-shipped", "InstalledVersion": "1.0"},
                    ],
                }
            ]
        }
        self.assertEqual(
            scope_donor_report(report, inventory)["Results"][0]["Vulnerabilities"], [matching]
        )
        with self.assertRaisesRegex(ValueError, "omitted copied packages"):
            scope_donor_report({"Results": []}, inventory)

    def test_deduplicates_reports_but_keeps_unfixed_findings_visible(self):
        item = {
            "PkgName": "pillow",
            "InstalledVersion": "12.3.0",
            "VulnerabilityID": "CVE-test",
            "Severity": "HIGH",
            "FixedVersion": "13.0.0",
        }
        unfixed = {**item, "VulnerabilityID": "CVE-upstream", "FixedVersion": ""}
        result = summarize(
            {"Results": [{"Class": "lang-pkgs", "Vulnerabilities": [item, item, unfixed]}]}
        )
        self.assertEqual(result["distinctPackageAdvisories"], 2)
        self.assertEqual(len(result["blocking"]), 2)
        self.assertEqual(len(result["unreviewedUnfixedHighCritical"]), 1)
        self.assertEqual(len(result["unfixedHighCritical"]), 1)
        self.assertEqual(result["affectedPackages"], 1)

    def test_unfixed_requires_review_and_fixable_cannot_use_an_exception(self):
        item = {"PkgName": "pillow", "InstalledVersion": "12", "VulnerabilityID": "CVE-upstream", "Severity": "CRITICAL"}
        report = {"Results": [{"Class": "lang-pkgs", "Vulnerabilities": [item]}]}
        self.assertEqual(len(summarize(report)["blocking"]), 1)
        with patch("image_security.disposition", return_value={"disposition": "mitigated"}):
            result = summarize(report, scope="face-cpu")
            self.assertEqual(result["blocking"], [])
            self.assertEqual(len(result["unfixedHighCritical"]), 1)
            self.assertEqual(len(result["reviewedUnfixedHighCritical"]), 1)
            item["FixedVersion"] = "13"
            self.assertEqual(len(summarize(report, scope="face-cpu")["blocking"]), 1)

    def test_actual_image_id_is_scanned_and_fixable_findings_fail_closed(self):
        image_id = "sha256:" + "a" * 64
        with tempfile.TemporaryDirectory() as name:
            directory = pathlib.Path(name)
            report = {
                "Metadata": {"ImageID": image_id},
                "Results": [
                    {
                        "Vulnerabilities": [
                            {
                                "PkgName": "pillow",
                                "InstalledVersion": "12",
                                "VulnerabilityID": "CVE-test",
                                "Severity": "CRITICAL",
                                "FixedVersion": "13",
                            }
                        ]
                    }
                ],
            }
            (directory / "vulnerabilities.json").write_text(json.dumps(report))
            with (
                patch(
                    "subprocess.check_output", return_value=json.dumps([{"Id": image_id}])
                ) as inspect,
                patch("subprocess.run") as run,
            ):
                with self.assertRaisesRegex(RuntimeError, "block release"):
                    scan_image("mutable:tag", directory)
                for call in run.call_args_list:
                    self.assertEqual(call.args[0][-1], image_id)
                self.assertTrue((directory / "summary.json").exists())

    def test_unlabeled_images_scan_with_null_empty_or_missing_labels(self):
        image_id = "sha256:" + "a" * 64
        for config in (None, {}, {"Labels": None}, {"Labels": {}}):
            with self.subTest(config=config), tempfile.TemporaryDirectory() as name:
                directory = pathlib.Path(name)
                inspection = {"Id": image_id, "Config": config}
                (directory / "vulnerabilities.json").write_text(
                    json.dumps({"Metadata": {"ImageID": image_id}, "Results": []})
                )
                with (
                    patch("subprocess.check_output", return_value=json.dumps([inspection])),
                    patch("subprocess.run") as run,
                ):
                    result = scan_image("unlabeled", directory)
                    self.assertEqual(result["imageId"], image_id)
                    self.assertEqual(run.call_count, 2)
                    run.reset_mock()
                    with self.assertRaisesRegex(ValueError, "requires the reviewed native"):
                        scan_image("video", directory, require_native=True)
                    run.assert_not_called()

    def test_video_cannot_omit_or_change_native_scan_contract(self):
        for marker in (None, "unknown-version"):
            with self.subTest(marker=marker), tempfile.TemporaryDirectory() as name:
                inspection = {
                    "Id": "sha256:" + "a" * 64,
                    "Config": {"Labels": {"org.stillmark.native-security": marker}},
                }
                with (
                    patch("subprocess.check_output", return_value=json.dumps([inspection])),
                    patch("subprocess.run") as run,
                ):
                    with self.assertRaisesRegex(ValueError, "requires the reviewed native"):
                        scan_image("video", name, require_native=True)
                    run.assert_not_called()

    def test_rejects_report_for_another_artifact(self):
        with tempfile.TemporaryDirectory() as name:
            p = pathlib.Path(name)
            (p / "vulnerabilities.json").write_text('{"Metadata":{"ImageID":"wrong"}}')
            with (
                patch(
                    "subprocess.check_output",
                    return_value=json.dumps([{"Id": "sha256:" + "a" * 64}]),
                ),
                patch("subprocess.run"),
            ):
                with self.assertRaisesRegex(ValueError, "requested immutable image"):
                    scan_image("some:tag", p)


if __name__ == "__main__":
    unittest.main()
