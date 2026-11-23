"""Local checks; no deployment or production credentials required.

With --reuse-hosted-run (a release passes it), the checks whose answer depends only on
the source are skipped when GitHub already passed them on these exact files. Everything
that depends on today's advisories, on this machine or on what is deployed always runs.
The hosted job and a plain local run pass no flag and run everything.
"""

import os
import sys
import time

import ci_evidence
from common import ROOT, run as execute

os.chdir(ROOT)
covered, evidence = (
    ci_evidence.verified() if "--reuse-hosted-run" in sys.argv[1:] else (False, "not requested")
)
print(f"Source-only checks: {'skipped, ' + evidence if covered else 'running here (' + evidence + ')'}")
timings = []


def run(args, **kwargs):
    started = time.monotonic()
    try:
        return execute(args, **kwargs)
    finally:
        timings.append((time.monotonic() - started, " ".join(args)))


def source_only(args, **kwargs):
    """A check that gives the same answer for the same files, wherever it runs."""
    if not covered:
        run(args, **kwargs)


run(["node", "scripts/render-deployment.mjs"])
run(["node", "--test", "scripts/docs/validate.test.mjs"])
run(["npm", "run", "docs:check"])
run(["python3", "scripts/release/check_setup.py"])
run(["npm", "run", "format:check"])
run(["npm", "run", "lint"])
run(["gitleaks", "git", "--redact"])
run(["python3", "scripts/release/test_safety.py"])
run(["python3", "scripts/release/test_source_snapshot.py"])
run(["python3", "scripts/release/test_setup_guard.py"])
run(["python3", "scripts/release/test_database_gate.py"])
run(["python3", "scripts/release/test_video_image.py"])
run(["python3", "scripts/release/test_image_security.py"])
run(["python3", "scripts/release/test_deployed_images.py"])
run(["python3", "scripts/release/test_ci_evidence.py"])
run(["python3", "scripts/release/test_postgres_tools.py"])
run(["python3", "scripts/release/test_advisory_reviews.py"])
run(["python3", "scripts/release/test_npm_security.py"])
run(["python3", "-m", "unittest", "discover", "-s", "scripts/release", "-p", "test_native_*.py"])
run(
    ["python3", "-m", "unittest", "discover", "-s", "workers/face-cpu", "-p", "test_publication.py"]
)
for worker in ["face-cpu", "search-cpu"]:
    run(
        [
            "python3",
            "-m",
            "unittest",
            "discover",
            "-s",
            f"workers/{worker}",
            "-p",
            "test_warm_idle.py",
        ]
    )
for test in ["test_rerank_publication.py", "test_capacity.py", "test_travel_summaries.py", "test_search_inference_liveness.py"]:
    run(["python3", "-m", "unittest", "discover", "-s", "workers/search-cpu", "-p", test])
# The full browser matrix includes more than 140 fresh contexts. Hosted runners
# need a suite budget separate from the unchanged five-second assertion deadline.
source_only(["npm", "run", "test:client-recovery"], timeout=600)
source_only(["node", "scripts/verification/frontend-recovery.mjs"], timeout=600)
source_only(["node", "--expose-gc", "scripts/verification/catalog-scale.mjs"], timeout=180)
source_only(["node", "scripts/verification/search-http-responsiveness.mjs"], timeout=180)
source_only(["npm", "run", "test:load-harness"], timeout=180)
source_only(["node", "--test", "scripts/auth0/credential-recovery.test.mjs"], timeout=180)
source_only(
    [
        "node",
        "--test",
        "scripts/load-test/cloud/server.test.mjs",
        "scripts/load-test/app-processes.test.cjs",
    ],
    timeout=180,
)
for args in [
    ["npm", "run", "typecheck"],
    ["npm", "test"],
    ["npm", "--prefix", "cloudflare-gateway", "test"],
    ["python3", "scripts/release/check_database.py"],
    ["npm", "run", "build"],
    ["npm", "run", "test:smoke"],
]:
    source_only(args)
run(["python3", "scripts/release/npm_security.py"])

# The inventories of the pinned, deployed image digests, which keep the packages they
# were built with. Run before the long source builds so its answer is never lost.
run(["python3", "scripts/release/deployed_images.py", "check"], timeout=1800)

# Mandatory: actual worker libraries/models and OS/language SBOM vulnerability gate.
# These are fresh builds: they prove current source, not the running images.
run(["python3", "scripts/release/check_worker_images.py"], timeout=14400)

print("Slowest checks:")
for seconds, command in sorted(timings, reverse=True)[:8]:
    print(f"  {seconds:6.0f}s  {command}")
