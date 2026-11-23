# Upload processing benchmark

Finite diagnostic job for the existing upload CPU pool. It uses the production
photo ingest implementation with opt-in stage timings, the same base image and
one CPU / 5 GiB limits. It compares 1, 2, 4, 4, 2, 1 concurrent operations on a
fixed set of up to twelve owned 3–10 MB JPEGs. The reverse pass reduces ordering
bias. CPU cgroup usage/throttling, process RSS, event-loop delay, throughput and
per-file stage durations are emitted as bounded JSON lines prefixed UPLOAD_BENCH.

Originals stay in Snowflake. The runner makes temporary staged chunks, exercises
real chunk reads, image transformations, stage PUTs, and catalog publication.
Publication transactions roll back, so no test photos or AI descriptions are
published. A specially named, explicitly selected private fixture album is
required. Delete that empty fixture album only after verifying cleanup. Generated
stage outputs and chunk copies are removed in the runner's finally block; if the
job is killed, inspect its cleanup intents and fixture prefix before retrying.

This measures warm steady-state server processing, not laptop upload bandwidth,
HTTP/authentication latency, client retry/backoff, instance startup, lease recovery,
or committed transaction WAL latency. It is a single-instance JPEG benchmark,
not a video, cross-instance, or 100,000-user capacity test. The job runs through
internal database identity context, not a public diagnostic endpoint. Never expose
this runner as an HTTP route or ship its configuration as production defaults.

Set `UPLOAD_WORKER_IMAGE` to the reviewed worker image (required; no stale default).
Build from the repo root after installing the gateway's development dependencies:

```sh
node workers/upload-cpu/benchmark/build.mjs
docker build --platform linux/amd64 -f workers/upload-cpu/benchmark/Dockerfile \
  --build-arg UPLOAD_WORKER_IMAGE="$UPLOAD_WORKER_IMAGE" \
  -t stillmark-upload:bench-v1 workers/upload-cpu/dist/benchmark
```

The base image tag must correspond to the deployed worker. Build/push a unique
benchmark tag. Use the worker's resource limits, PG secret and egress integration,
without an HTTP endpoint, readiness probe, maintenance credential, or warehouse.
Set BENCH_OWNER and BENCH_EVENT_ID only for the reviewed fixture. Use an isolated
service and pool with a writable test catalog and test-only stage paths. Never
redirect production traffic for this benchmark. Stop and remove the isolated
resources after collecting results and verifying cleanup. Production uploads keep
using their dedicated service throughout.
