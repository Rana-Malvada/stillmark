# Multi-worker upload processing benchmark

Finite operator-run producer, not an app endpoint or background loop. It copies a fixed
set of 32 existing photos/videos into staged upload chunks and uses the real queue
acceptance path. Every enqueue and a 24-hour `next_attempt` hold commit atomically, so
ordinary workers cannot start a partial trial. An operator releases only that trial's
jobs once its workers are ready. Normal lease expiry, processing and publication code
remain unchanged. This is a server processing benchmark, not browser/network load.

Build from the repository root with `node workers/upload-cpu/scale-benchmark/build.mjs`.
Build a uniquely tagged image with this Dockerfile and `dist/scale-benchmark` as context,
using the exact deployed upload worker base image. Run as a finite Snowflake job with
restricted app/queue secrets and storage EAI. No warehouse is selected.

Required inputs: `VALIDATE_OWNER` (verified main administrator), `VALIDATE_EVENT_ID`
(private owned album prefixed `__upload_scale_benchmark_`), and `BENCH_SOURCE_IDS` (JSON
array of exactly 32 distinct positive photo IDs, each JPEG/MOV/MP4 up to 64 MB). Source
media stays within Snowflake; hashes and lengths are checked before staging. Keep IDs,
signed URLs and credentials out of committed artifacts.

Before execution, confirm there are no user uploads or pending processing jobs. Save
routing state and disable its controller during the isolated measurement. Prevent the
app worker and unrelated pool workers from claiming these jobs. Use a separate bounded
compute pool, with fixed instance counts 1, 2, 4, 4, 2, 1, two slots per instance, and
identical inputs in separate fixture albums. Suppress paid AI only for exact fixture
album IDs; do not disable AI for real albums. Record and remove any temporary scoped
fixture guard during cleanup.

Collect queue snapshots, release/completion timestamps, attempts, saved results, unique
photo/hash counts, per-instance claim logs and database activity. Treat sampled wait and
processing durations as approximate and shared database counters as account workload,
not exclusive benchmark measurements. Do not interpret a small test as 100,000-user proof.

On failure, do not mark a trial passed or blindly rerun its producer. Inspect staged jobs
and logs first. After every run, verify fixtures, schedule their media paths for normal
cleanup, remove fixture catalog/queue/session rows and the scoped AI guard, restore the
original routing state, drop all test services, suspend the test pool, verify zero nodes,
and drop it. Never broaden cleanup to user albums or stage prefixes.
