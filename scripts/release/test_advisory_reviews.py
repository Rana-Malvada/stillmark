import datetime
import hashlib
import json
import pathlib
import tempfile
import unittest

from advisory_reviews import disposition, load_reviews


def review_entry(digest):
    return {
        "scope": "search-cpu", "class": "os-pkgs", "package": "example", "version": "1.0",
        "id": "CVE-example", "severity": "HIGH", "disposition": "mitigated",
        "reason": "Synthetic review used only by the policy test", "exposure": "Synthetic path",
        "mitigation": "Synthetic isolation", "reviewedBy": "Test fixture",
        "reviewedAt": "2026-11-20", "expiresAt": "2026-12-01",
        "evidence": ["https://example.invalid/advisory"], "sourceBindings": {"worker.py": digest},
    }


class AdvisoryReviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        (self.root / "worker.py").write_text("synthetic source")
        self.review = review_entry(hashlib.sha256(b"synthetic source").hexdigest())
        self.policy = self.root / "policy.json"
        self.finding = {key: self.review[key] for key in ("class", "package", "version", "id", "severity")}

    def load(self, entries=None):
        self.policy.write_text(json.dumps({"schemaVersion": 1, "reviews": entries if entries is not None else [self.review]}))
        return load_reviews(self.policy)

    def lookup(self, **kwargs):
        return disposition(self.load(), kwargs.get("scope", "search-cpu"), kwargs.get("finding", self.finding), root=self.root, today=kwargs.get("today", datetime.date(2026, 11, 21)))

    def test_exact_review_is_retained(self):
        self.assertEqual(self.lookup(), self.review)

    def test_package_version_advisory_scope_severity_changes_invalidate(self):
        for key in ("package", "version", "id", "class", "severity"):
            with self.subTest(key=key):
                self.assertIsNone(self.lookup(finding={**self.finding, key: "changed"}))
        self.assertIsNone(self.lookup(scope="upload-cpu"))

    def test_changed_source_expired_or_future_review_invalidates(self):
        self.assertIsNone(self.lookup(today=datetime.date(2027, 1, 1)))
        self.assertIsNone(self.lookup(today=datetime.date(2026, 11, 19)))
        (self.root / "worker.py").write_text("changed")
        self.assertIsNone(self.lookup())

    def test_incomplete_or_duplicate_review_rejected(self):
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            self.load([self.review, self.review])
        for key in ("evidence", "sourceBindings", "mitigation", "reviewedBy"):
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.load([{**self.review, key: None}])

    def test_review_window_is_bounded(self):
        self.load([{**self.review, "reviewedAt": "2026-11-20", "expiresAt": "2026-12-20"}])
        with self.assertRaisesRegex(ValueError, "Review window"):
            self.load([{**self.review, "reviewedAt": "2026-11-20", "expiresAt": "2026-12-21"}])
        with self.assertRaisesRegex(ValueError, "Review window"):
            self.load([{**self.review, "reviewedAt": "2026-11-20", "expiresAt": "2026-11-19"}])

    def test_cannot_bind_source_outside_checkout(self):
        self.review["sourceBindings"] = {"../outside": "a" * 64}
        self.assertIsNone(self.lookup())


if __name__ == "__main__":
    unittest.main()
