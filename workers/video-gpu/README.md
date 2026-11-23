# Production GPU video worker

This directory contains the production video-preparation worker. It creates playback
renditions, not AI descriptions. Original media stays unchanged.

| File                   | Purpose                                                          |
| ---------------------- | ---------------------------------------------------------------- |
| `worker.ts`            | Claims queued videos, converts, validates, and publishes results |
| `plan.ts`              | Encoder planning                                                 |
| `postgres.mjs`         | Restricted worker database connection                            |
| `production-spec.json` | Worker image, resources, mounts, and runtime bounds              |
| `build.mjs`            | Bundles the worker with its database adapter                     |
| `Dockerfile`           | Builds the runtime with FFmpeg and Node already installed        |
| `build-control.py`     | Renders proposed control SQL to stdout; does not deploy          |
| `provision.sql`        | Role/integration reference; not a complete fresh-install script  |

The immutable worker image is recorded in `production-spec.json`; a source update
alone does not deploy it. The production controls inject the run ID and set the per-run job cap to 10,000; the standalone specification's default
is three jobs. Encoder concurrency is two. Originals mount from `PHOTO_FILES`;
outputs mount under `DERIVED_FILES/display/prepared`.

See [Operations](OPERATIONS.md) before changing images or controls.

## Automatic admission and warm idle

With `AUTOMATIC_MEDIA_PROCESSING_ENABLED=true`, committed new video sources create
durable playback signals. The coordinator admits exact eligible videos into an
accepting run or creates a deterministic job. Existing failed/cancelled backlog
requires explicit recovery. Activity → Processing provides progress and failed-file retry. Playback has no user-facing Stop control; operator cancellation uses the existing control procedure.
This prepares playback renditions; photo/video AI descriptions remain separate.

When there is no claimable work, the worker checks the run's idle state. Queued or
running claims keep it alive; fifteen minutes without work seals admission. New
uploads arriving before that boundary can reuse the same worker. Admission and
idle expiry serialize on the run row, so work arriving after sealing remains
signalled for a subsequent run. The original cycle deadline, per-job bounds,
encoder concurrency and cancellation still apply; idle waiting does not extend
them. The warm-idle check runs every five seconds, only while this job is alive.

The process warm period and native Snowflake pool auto-suspend are different.
The existing GPU pool's native setting remains 60 seconds; future provisioning
uses 900 seconds. A running warm job holds its processes independently of that
setting. Controllers settle compute only after active jobs/services are gone.
Deploy the additive automatic-work and worker-warm-idle migrations before new
application/worker versions, and verify actual pool state after release.
