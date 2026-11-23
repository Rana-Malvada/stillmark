"""Exact, expiring advisory dispositions; never an implicit allowlist."""

import datetime
import hashlib
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]
DISPOSITIONS = {"affected-path-excluded", "feature-disabled", "mitigated", "accepted-risk"}
# An accepted advisory must be looked at again at least this often. A longer window
# would let a review outlive the facts it was written against.
MAX_REVIEW_DAYS = 30


def load_reviews(path):
    policy = json.loads(path.read_text())
    if policy.get("schemaVersion") != 1 or not isinstance(policy.get("reviews"), list):
        raise ValueError(f"Invalid advisory review policy: {path.name}")
    reviews = {}
    for review in policy["reviews"]:
        key = tuple(review.get(k) for k in ("scope", "class", "package", "version", "id"))
        if any(not isinstance(value, str) or not value.strip() for value in key):
            raise ValueError("Advisory reviews require an exact scope/class/package/version/id")
        if key in reviews:
            raise ValueError(f"Duplicate advisory review: {key}")
        if review.get("disposition") not in DISPOSITIONS:
            raise ValueError(f"Invalid advisory disposition: {key}")
        if any(not isinstance(review.get(k), str) or not review[k].strip() for k in (
            "reason", "exposure", "mitigation", "reviewedBy", "reviewedAt", "expiresAt"
        )):
            raise ValueError(f"Incomplete advisory review: {key}")
        if review.get("severity") not in ("HIGH", "CRITICAL"):
            raise ValueError(f"Review must bind the assessed severity: {key}")
        if not isinstance(review.get("evidence"), list) or not review["evidence"] or any(
            not isinstance(value, str) or not value.startswith("https://") for value in review["evidence"]
        ):
            raise ValueError(f"Review needs primary-source evidence links: {key}")
        if not isinstance(review.get("sourceBindings"), dict) or not review["sourceBindings"]:
            raise ValueError(f"Review needs source/configuration bindings: {key}")
        for name, digest in review["sourceBindings"].items():
            if not isinstance(name, str) or not isinstance(digest, str) or len(digest) != 64 or any(
                char not in "0123456789abcdef" for char in digest
            ):
                raise ValueError(f"Invalid source binding: {key}")
        reviewed = datetime.date.fromisoformat(review["reviewedAt"])
        expires = datetime.date.fromisoformat(review["expiresAt"])
        if not datetime.timedelta(0) <= expires - reviewed <= datetime.timedelta(days=MAX_REVIEW_DAYS):
            raise ValueError(f"Review window must be 0 to {MAX_REVIEW_DAYS} days: {key}")
        reviews[key] = review
    return reviews


def disposition(reviews, scope, finding, *, root=ROOT, today=None):
    key = (scope, finding["class"], finding["package"], finding["version"], finding["id"])
    review = reviews.get(key)
    if not review or review["severity"] != finding["severity"].upper():
        return None
    today = today or datetime.datetime.now(datetime.timezone.utc).date()
    if not datetime.date.fromisoformat(review["reviewedAt"]) <= today <= datetime.date.fromisoformat(review["expiresAt"]):
        return None
    root = root.resolve()
    for relative, expected in review["sourceBindings"].items():
        path = (root / relative).resolve()
        if not path.is_relative_to(root) or not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            return None
    return review
