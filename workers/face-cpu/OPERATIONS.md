# Face scan operations

## Normal operation

With automatic media processing enabled, committed new photo sources produce
admission signals and the coordinator joins an accepting run or starts a new one.
An administrator can also start/retry a scan from Activity → Processing. The app
records a `face_scan_runs` row, assigns eligible queued photos and calls
`FACE_SCAN_CONTROL(run, 'START')`. The deterministic launcher resumes the face CPU
pool if needed and starts `FACE_SCAN_<run>`. Missing launches are retried with
persisted backoff within the original startup deadline.

After draining work, face grouping is published before the worker waits warm for
up to fifteen minutes. New admitted photos reset idle; queued/running work prevents
idle exit. Cancellation, original runtime limits and sealing admission before exit
remain authoritative. Progress includes heartbeats, processed/failed counts,
faces found and warm-idle state. See the [worker overview](README.md) for the
process-idle versus compute-pool distinction.

Completed photos are skipped on later runs unless their original changes. Faces with a
confirmed assignment and manual tags are never replaced or removed by a scan.

## Runtime and cost bounds

- Work budget `WORKER_MAX_SECONDS=7200` (120 minutes); container `timeout` 7,500 s
  (125 minutes) plus 30 s kill grace. The extra five minutes allow final publication
  and grouping. Images from `cpu-v8-20261109-673f99c` onward, including the image configured in
  `config/deployment.json`, support this budget; `cpu-v6` rejects budgets
  above 7,000 seconds and must not be used with these controls.
- 6 CPU / 23 GiB limit with six parallel analysis processes on a one-node `CPU_X64_M` pool, no auto-resume. The existing native auto-suspend is 60 s; new provisioning templates use 900 s. This is separate from the worker's 900 s warm-idle period.
- Per-photo retries: three attempts with backoff; failures stay visible with an error class.
- `SETTLE` suspends the face pool only when no job or service remains on it. The video
  GPU pool is never referenced by these controls.

Configured limits are safeguards. Verify actual pool state with
`SHOW COMPUTE POOLS LIKE 'PERSONAL_PHOTOS_FACE_CPU'` after a failed run.

## First-time provisioning (reviewed, explicit approval required)

1. Apply Postgres migrations `202610072000_people_faces` and `202610072010_people_worker_queue`
   with `python3 scripts/release/migrations.py apply`.
2. As `snowflake_admin`, set a generated password on `personal_photos_face_worker`.
3. Review and apply `workers/face-cpu/provision.sql`, supplying the same password to the
   secret at apply time. Grant `PERSONAL_PHOTOS_FACE_LAUNCHER` to the role that owns
   the control procedures during setup, as was done for video.
4. Build and push the image (below), then review and apply the controls.

## Build and release a worker change

1. Review `production-spec.json`, worker code and the `face_worker` database contract.
2. Run `./workers/face-cpu/test-in-image.sh` (optionally with `FACE_SAMPLE_IMAGE=<jpg>`).
3. Build `linux/amd64` from this directory and push a new immutable tag to the existing
   image repository. Never overwrite a deployed tag.
4. Update `FACE_IMAGE` in `config/deployment.json` and run `npm run config:render`.
5. Run `python3 workers/face-cpu/build-control.py > /tmp/face-control-review.sql`, review
   it against the deployed procedures, ownership and grants, then apply it as a
   separately reviewed change. An app deployment does not publish the image or controls.
6. Run an explicitly authorized pilot run with a small photo limit; verify progress,
   crops under `DERIVED_FILES/faces/`, unchanged originals, retries and pool suspension.

Changing the model is a new `MODEL_VERSION`. Existing faces remain under the old version
until a reviewed rescan; matching compares only faces of the same version.

## Investigation and recovery

### Oversized boxes from tiled detection

The tiled-coordinate fix in `faces.py` translates box origins and landmarks while
preserving width and height. Earlier workers also added the tile offsets to width
and height, inflating stored boxes and crops, changing duplicate suppression, and
potentially admitting small faces as matching references. Recognition landmarks
were translated correctly; whole-photo similarity is not used for grouping.

Publishing the corrected worker prevents this on newly scanned photos, but does
not repair stored detections. Ordinary scans skip completed photos. Recovery needs
a reviewed, targeted rescan that preserves manual tags, confirmed assignments,
ignored faces, rejections, and selected covers; do not blanket-reset the queue.
The current publish function protects confirmed assignments, but replaces other
detections, so it is not by itself a complete correction-preserving repair tool.

The viewer face-ID normalization is a separate app change: without it, a link's
requested face can fail to select, and the manual highlight toggle chooses the
first detected face instead. Deploying only the worker does not fix that behavior.

Compare `face_scan_runs`, `face_scan_queue` statuses and the Snowflake job status.
A failed job may already have published faces; inspect failed items rather than
resetting the library. Cancelling a job does not delete faces or crops; expired claims
are recovered by the queue. Never delete originals or user corrections to troubleshoot.

### Running the in-place tiled-box repair

`repair.py` is an explicit maintenance entrypoint, separate from normal scanning.
Build `Dockerfile.repair` against the verified cpu-v6 image (pass `BASE_IMAGE`), run
`test_repair.py` inside it, and publish a new immutable repair image tag. Use the
normal face job's mounts, secret, S-pool resources and timeout, changing its command
to `/worker/repair.py`. Set a unique `REPAIR_RUN_ID`, a fixed `REPAIR_MAX_FACE_ID`
from the reviewed catalog snapshot, and optionally `REPAIR_LIMIT` for a pilot.
Restart with the same run ID and watermark to continue completed-photo checkpoints.

The worker requires temporary column-level UPDATE on `public.faces` for
`box_x,box_y,box_w,box_h,quality,quality_ok,crop_path`; record existing privileges
and revoke the temporary grant when repair finishes. No assignment or person writes
are performed. Originals remain read-only. Recovery receipts and per-photo completion
records are private stage files named `faces/repair-<run>-...json`; normal crop APIs
cannot serve them. Receipts include old geometry and crop references before updates.
Old crops are retained for recovery. Successful repairs preserve face IDs, names,
assignments, rejections, ignored state and chosen cover face IDs. The cover's crop
is corrected along with the face, but another face is never chosen as the cover.

Each candidate must reproduce the original normalized box and have cosine similarity
at least 0.9999 to its saved embedding. Ambiguous, missing or concurrently changed
records are reported for review rather than rewritten. Faces suppressed by the old
scanner are not added by this geometry-only repair, and groups are not rebuilt.
Review `repair_finished` counts, outstanding receipts and pool suspension. A job
that reaches its time budget may exit successfully with remaining work; resume it.

### Dense-photo publication

Migration `202611041200_dense_face_publication.sql` accepts up to 5,000 faces in
one atomic publication. Detections are never silently truncated. Claim validation,
owner isolation and confirmed-face preservation remain required; malformed or
oversized payloads fail before existing faces change. Finalization reports terminal
failed-photo counts rather than retry-attempt counts.

Validate dense publication, size rejection, retry counts and recovery using the
worker and native database regression tests. Store execution results in `.release/`.
