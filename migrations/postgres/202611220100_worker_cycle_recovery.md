# Bounded automatic worker recovery

Adds retry scheduling to automatic search, and preserves the original three-hour
cycle across face and playback worker crashes. A cycle allows at most three
crash recoveries; per-file claim attempts are never reset. Stopped, expired and
terminal bad-media work is not automatically revived. Face organization can
continue after the photo queue is empty, with its owners recovered from the run
lineage. The existing fifteen-minute warm-idle policy remains unchanged.

Deploy this additive migration before the application and face worker images.
Old images ignore the new columns, so roll back application and worker images
before removing them. Existing face runs receive a deadline three hours after
migration, because they did not previously store an absolute cycle deadline.
No original files, photo metadata or permissions are changed.

Validation: automatic-work, face-scan and video-preparation tests exercise
provider failures, Stop, crash attempts, expired claims, terminal failures and
organization-only continuation. scripts/verification/automatic-work.mjs executes
search retries and worker recovery against disposable native PostgreSQL.
workers/face-cpu/test_inference_liveness.py kills real hung/crashed subprocesses
and verifies independent lease renewal. The worker image gate additionally runs
real model inference and the organization deadline tests.
