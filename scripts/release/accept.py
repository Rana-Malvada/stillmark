"""Record human verification and tag exactly the deployed commit."""

import argparse, json, re
from common import ROOT, run

p = argparse.ArgumentParser()
p.add_argument("record")
p.add_argument("--verified", required=True, choices=["login-gallery-photo-video-access"])
a = p.parse_args()
f = (ROOT / a.record).resolve()
if not f.is_relative_to(ROOT / ".release"):
    raise SystemExit("Record must be in .release")
r = json.loads(f.read_text())
if r["state"] != "public-checks-passed-awaiting-signed-in-check":
    raise SystemExit("Public checks have not passed")
tag = "release-" + f.parent.name
run(
    [
        "git",
        "tag",
        "-a",
        tag,
        r["commit"],
        "-m",
        "Verified production release; see local release record " + str(f.relative_to(ROOT)),
    ]
)
r["state"] = "accepted"
r["signedInChecks"] = a.verified
r["tag"] = tag
f.write_text(json.dumps(r, indent=2) + "\n")
print("Accepted " + tag + ". Push this tag to the private remote.")
