# Face scan worker

Finite Snowpark Container Services job that powers People. It detects faces in
original photos, stores 128-dimension SFace embeddings and small WebP crops, then
matches and groups faces per album owner. Originals are mounted read-only and never
modified. Recognition never trains or changes a model: names come only from users,
and confirmed faces become per-person reference examples, including detections
that fail the detector quality gate. Named recognition requires agreement across
reference photos; automatic results never train named recognition. Confirmations
queue a background pass over existing unassigned embeddings. No rescan is needed.

| File                   | Purpose                                                       |
| ---------------------- | ------------------------------------------------------------- |
| `faces.py`             | Decode with EXIF orientation, detect, assess quality, embed   |
| `cluster.py`           | Conservative average-linkage grouping of unassigned faces     |
| `bounded_merge.py`     | Resumable whole-group merging with durable pair checkpoints   |
| `worker.py`            | Claims a run's queue, publishes with fencing, matches, groups |
| `test_faces.py`        | Unit tests; model tests run when weights and a sample exist   |
| `test-in-image.sh`     | Builds the amd64 image and runs the tests inside it           |
| `models.lock`          | Pinned model URLs and SHA-256; verified during image build    |
| `LICENSES.md`          | Third-party model licences                                    |
| `production-spec.json` | Rendered job spec: image, CPU/memory limits, mounts, timeouts |
| `provision.sql`        | Rendered pool/role/secret/integration reference               |
| `build-control.py`     | Renders proposed control procedures to stdout; never applies  |

The job connects as the `personal_photos_face_worker` Postgres role. It calls the
`face_worker` schema functions (`migrations/postgres/202610072010_people_worker_queue.sql`),
which run with the worker's own rights, so the role also holds direct table grants
across all owners: read on selected photo and album columns and face settings, and
write on faces, people, assignments, the scan queue and runs, plus insert on stage
cleanup (`migrations/postgres/202610072000_people_faces.sql`). It has no access to
accounts, permissions, sharing or other catalog tables. Separation between owners
inside those face tables is enforced by the worker code and its fenced functions,
not by row security for this role.
The job runs on its own CPU pool and has no rights on the video GPU pool.

Templates live in `config/templates/workers/face-cpu/` and
`config/templates/face-control.sql`; run `npm run config:render` after changing them.

Local development: `python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt`,
download the weights listed in `models.lock` into `models/` (ignored by Git), then
`FACE_SAMPLE_IMAGE=<photo> .venv/bin/python -m unittest discover -s . -p 'test_*.py'`.

See [Operations](OPERATIONS.md) before building images or changing controls.

## Automatic admission and warm idle

With `AUTOMATIC_MEDIA_PROCESSING_ENABLED=true`, newly committed photo sources
create durable face-work signals. The coordinator admits only those source IDs
and reuses an accepting run, or starts a deterministic job. Existing failed or
cancelled backlog is not silently retried by this path. Administrators retain
explicit scan/retry and Stop controls in Activity → Processing.

After finishing available work, the worker publishes face organization immediately
and keeps its analysis processes warm for up to **15 minutes** without work. It
checks admission/cancellation every five seconds during that warm period. New work
resets the idle period; queued/running claims prevent idle shutdown. Admission and
idle expiry lock the same run row, and the worker seals admission before exit, so
later uploads keep their signals for another run. Original finite work/runtime
limits and explicit Stop still apply.

This process-idle period is distinct from Snowflake compute-pool auto-suspend.
The existing deployed face pool retains its 60-second native idle setting; new
provisioning templates specify 900 seconds. A running warm job keeps its processes
alive independently of that setting. After job exit the controller settles the
pool only when no jobs/services remain. Verify effective deployed settings rather
than assuming a template change altered an existing pool.

Apply the additive launch-recovery, automatic-work and worker-warm-idle migrations
before deploying the compatible app and worker images. Validate native admission
versus expiry, active-claim preservation, cancel/restart, same-run reuse and
`test_warm_idle.py`. The app and worker images are separate release artifacts.

## Parallelism validation

Run `benchmark_parallel.py --workers 6 --manifest /tmp/paths.json` inside the
candidate image with a private manifest of relative original-stage paths. Compare
CPU settings using identical inputs, output hashes, cold/warm timings and memory.
The script reads originals without changing assignments or groups. Keep results
outside Git. Include publication, stage writes and grouping in separate end-to-end
checks; analysis-only timings do not establish scan throughput.

## Bounded organization and merge recovery

Unassigned-face grouping retains its 5,000-face admission limit and conservative
average-linkage rule. Its linkage matrix is disk backed; candidate scores are
computed in 64-row blocks with cancellation and deadline checks. Interrupting
this computation does not publish partial groups or alter confirmed assignments.

Merging existing unnamed groups is a separate operation and has no 5,000-face
or 500-group input cutoff. It pages complete groups from PostgreSQL, scores their
closest-reference similarity in bounded blocks, and commits only the highest
eligible pair after completing a full pass. Each transaction absorbs one group.
Named, hidden, confirmed and rejection-target groups remain outside auto-merge.

`face_worker.merge_progress` saves the pair cursor and best candidate, while
statement-level generation changes invalidate scores after new faces or user
corrections. A restarted worker resumes from the last completed pair; the current
incomplete pair is rescored. In one worker, interrupted blocks continue on the
next time slice. Completed passes remain idle until data changes. The original
worker runtime and Stop controls remain authoritative.

Deploy `202611212330_bounded_unnamed_merge` before the compatible worker image.
Run `test_bounded_merge.py`, `test_cluster_deadline.py` and the real PostgreSQL
check `node scripts/verification/bounded-face-merge.mjs` from the repository root.
These use synthetic data and do not establish production concurrency capacity.
