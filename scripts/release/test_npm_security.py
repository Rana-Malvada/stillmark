import unittest
from unittest.mock import patch

from npm_security import classify, package_advisories


def report(name="compiler", version="1.0", severity="high"):
    return {"vulnerabilities": {name: {
        "nodes": [f"node_modules/{name}"], "fixAvailable": False,
        "via": [{"source": 123, "url": "https://example.invalid/advisory", "severity": severity, "range": "<2"}],
    }}}


class NpmSecurityTests(unittest.TestCase):
    def setUp(self):
        self.lock = {"packages": {"node_modules/compiler": {"version": "1.0", "dev": True}}}

    def test_dev_only_advisory_is_reported_and_blocks_separately(self):
        result = classify(report(), {"vulnerabilities": {}}, self.lock, scope=".", reviews={})
        self.assertEqual(result["runtimeFindings"], [])
        self.assertEqual(len(result["blockingBuild"]), 1)
        self.assertIn("not a demonstrated runtime exploit", result["buildFindings"][0]["exposure"])
        self.assertEqual(result["buildFindings"][0]["version"], "1.0")

    def test_review_does_not_bypass_runtime_high_critical_gate(self):
        with patch("npm_security.disposition", return_value={"disposition": "mitigated"}):
            result = classify(report(), report(), self.lock, scope=".", reviews={})
        self.assertEqual(len(result["blockingRuntime"]), 1)
        self.assertEqual(result["buildFindings"], [])

    def test_reviewed_build_finding_remains_visible(self):
        with patch("npm_security.disposition", return_value={"disposition": "mitigated"}):
            result = classify(report(), {"vulnerabilities": {}}, self.lock, scope=".", reviews={})
        self.assertEqual(result["blockingBuild"], [])
        self.assertEqual(len(result["reviewedBuild"]), 1)
        self.assertEqual(len(result["buildFindings"]), 1)

    def test_partial_report_missing_lock_or_dependency_advisory_fails(self):
        for value, lock in (({"error": "registry down"}, self.lock), (report(), {}), ({"vulnerabilities": {"compiler": {"via": ["missing"]}}}, self.lock)):
            with self.subTest(report=value), self.assertRaises(ValueError):
                package_advisories(value, lock)

    def test_informational_build_advisory_stays_visible_without_blocking(self):
        result = classify(report(severity="moderate"), {"vulnerabilities": {}}, self.lock, scope=".", reviews={})
        self.assertEqual(len(result["buildFindings"]), 1)
        self.assertEqual(result["blockingBuild"], [])


if __name__ == "__main__":
    unittest.main()
