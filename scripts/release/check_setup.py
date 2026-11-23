"""Offline guard: historical setup is evidence, not a migration runner."""

import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
expected = json.loads((ROOT / "setup/legacy-checksums.json").read_text())
actual = {
    str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest()
    for path in (ROOT / "setup").rglob("*")
    if path.suffix in (".sql", ".js")
}
if expected != actual:
    changed = sorted(
        key for key in expected.keys() | actual.keys() if expected.get(key) != actual.get(key)
    )
    raise SystemExit(
        "Historical setup changed; add a forward migration instead: " + ", ".join(changed)
    )
for path in (ROOT / "migrations/postgres").glob("*.sql"):
    if not path.with_suffix(".md").is_file():
        raise SystemExit("Missing compatibility/verification/rollback notes: " + str(path))
print(f"Verified {len(actual)} frozen setup files and migration review notes")
