# Video preparation operations

## Normal operation

With automatic media processing enabled, committed new video sources produce
playback signals. The coordinator admits exact eligible videos into an accepting
run, or creates a new durable run and calls `VIDEO_PREPARATION_CONTROL`.
Activity → Processing shows progress and failed-file retry. Playback has no user-facing Stop control; operator cancellation uses the existing control procedure.
A stable run ID produces a deterministic job name; missing launches receive bounded
backoff instead of creating duplicate runs. Processing continues independently of
the browser, and compatible ready renditions are skipped.

The worker stays warm for up to fifteen minutes after draining work. New admission
resets idle; queued/running claims prevent idle shutdown. Admission seals atomically
with idle expiry so later uploads remain signalled for the next run. Original cycle
deadlines and work limits are not extended. See the [worker overview](README.md).

The dedicated worker reads originals and writes derived media through separate stage
permissions. Publication uses database claims and fencing; a stale worker cannot
publish over a newer claim. AI analysis is a separate operation.

## Runtime and cost bounds

- App startup reconciliation retries absent jobs with persisted backoff inside the original 30-minute startup deadline. Existing pending jobs are not duplicated.
- The worker's work budget is 7,200 seconds; the container timeout is 7,500 seconds
  with a further 30-second forced-kill grace period.
- Per-file work and retries are bounded. Failed items remain visible for inspection.
- The deployed GPU pool retains native auto-suspend 60 s; new provisioning uses 900 s. The separate worker warm-idle period is 900 s.
- Control procedures and pool idle suspension manage shutdown. Verify actual pool
  state after a failed run; configured deadlines are not evidence of suspension.

These limits are safeguards, not expected startup or completion times. Read
`lib/video-preparation.ts`, `worker.ts`, and the deployed control definitions when
investigating a run. Repository configuration alone does not prove live state.

## Build and release a worker change

1. Review `production-spec.json`, worker code and database contracts. Complete the
   worker regression tests and commit the source before building the release image.
2. From the repository root, build a new version tag from that exact commit:

   ```sh
   python3 scripts/release/video_image.py --commit <full-commit-sha> --image <registry-path>:<new-version>
   ```

   The helper creates a minimal Git source archive, builds the bundle and locked
   production dependencies inside the amd64 image, and verifies its source revision
   and bundle hash without starting the worker. Host `dist/`, `node_modules`, dirty
   files and credentials are excluded. Record the emitted image ID and hashes with
   the release evidence. This verifies packaging, not GPU conversion behavior.

3. Publish the verified image to the existing Snowflake image repository. Do not
   overwrite a deployed tag. Record the registry digest after publishing.
4. Set `GPU_IMAGE` in `config/deployment.json` to the new immutable image reference,
   then run `npm run config:render` and `npm run config:check`. Review generated
   `production-spec.json` and provisioning changes; do not edit generated files alone.
5. Run `python3 workers/video-gpu/build-control.py > /tmp/video-control-review.sql`.
   Review the output against current deployed procedures, including ownership and
   grants. Capture it as a new forward change with verification/recovery notes.
6. Apply the separately reviewed control change. An app deployment does not publish
   this worker image or update these procedures automatically.
7. Perform an explicitly authorized bounded conversion test; verify playback,
   original preservation, output-stage boundary, progress, retries, and shutdown.

Do not replay historical setup or use removed benchmark jobs for production.

## Investigation and recovery

Compare `video_preparation_runs` and per-video playback states with Snowflake job
status. A failed job can already have published successful videos. Preserve ready
rows and inspect failed items instead of resetting the entire library.

Record job/container diagnostics and the pool state before cancelling. A control
rollback must retain compatibility with current database functions and manifests.
Stopping a job does not delete media; expired claims are recovered by the queue.
Never delete originals or ready renditions as a startup troubleshooting step.
