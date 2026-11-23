# Dedicated upload service

## Configuration

`settings.json` is authoritative for the image and resource/scaling bounds. The
production configuration uses CPU_X64_XS, automatic per-instance capacity, queued
processing and metrics. Automatic scale-out is disabled. Upload intent starts the
service; the controller suspends it after fifteen idle minutes with no active work.
See [production operations](../../docs/PRODUCTION.md).

Confirm live configuration and run the required controlled canary before routing
traffic to a changed worker. Prior results never authorize a different image.

Change the **instanceFamily in configuration**, then render and review the pool and
service update together. The renderer derives CPU requests/limits, memory limits,
resource-budget environment variables and `UV_THREADPOOL_SIZE` from the verified
family profile. Editing only the family in Snowflake does **not** expand an existing
container's limits. `CREATE IF NOT EXISTS` is not an upgrade: drain/suspend before
changing pool family, update the service specification, resume and verify readiness.
No generated SQL changes infrastructure automatically. Node-count and worker-count
bounds remain separate and the scaling evidence gate remains mandatory.
For enabled scaling, set `UPLOAD_SCALING_EVIDENCE` to an absolute private JSON report
path under `.release/` or another protected evidence directory. The renderer rejects
missing evidence, a different image, incomplete checks or an insufficient tested
instance cap. Disabled scaling needs no report. Never commit result reports.

At worker startup, automatic concurrency uses the lower of configured resource
ceilings and detected cgroup CPU/memory limits (including fractional CPU quotas).
It budgets at most two processing jobs per CPU, at least 1 GiB or 20% memory for
runtime/chunk handling, and 1.5 GiB per media job. Chunk admission has a separate
32 MiB-per-request budget after a 512 MiB runtime reserve. These are conservative
initial admission estimates, not a promise that every arbitrary media file fits.
Unknown memory uses a small fallback; invalid configuration fails closed. The queue
loop and HTTP completion admission share the same computed limit. Existing numeric
overrides remain available for controlled benchmarks. A restarted container
recalculates capacity; this does not change resource limits inside a running container.

Configured AWS profile defaults (before any tighter container limits):

| Instance family | Worker CPU | Memory limit | Processing slots | Chunk slots |
| --------------- | ---------: | -----------: | ---------------: | ----------: |
| CPU_X64_XS      |          1 |        5 GiB |                2 |           8 |
| CPU_X64_S       |          3 |       11 GiB |                5 |          24 |
| CPU_X64_M       |          6 |       26 GiB |               12 |          48 |
| CPU_X64_SL      |         14 |       56 GiB |               28 |         112 |
| CPU_X64_L       |         28 |      114 GiB |               56 |         224 |

Reverify family availability and allocatable CPU/memory with `SHOW COMPUTE POOL INSTANCE FAMILIES` in the target region/account. Unlisted families are rejected.
Larger resources do not establish end-to-end capacity; database pools, downstream
quotas and AI concurrency remain independently bounded.

## Routing control

The managed lifecycle drains accepted work before suspending the upload service
and pool, and resumes/verifies readiness before accepting new uploads. Durable routing is
stored in Postgres. Gateway configuration remains a separate rollout boundary; a
manual gateway-only switch does not prove that a pool drained or suspended.
See [queued processing](../../docs/queued-upload-processing.md).

The container runs the existing Next.js upload handlers in upload-only mode. This
keeps authorization, Postgres RLS, album rules, file validation, metadata extraction,
Sharp variants, video probing, hashing and stage writes on the same tested code path.
The public application does not relay upload bytes when gateway routing is enabled.
Only chunk POST/GET/DELETE and completion POST are accepted. Health is a local liveness
response, not a database, warehouse or stage query. No maintenance credential is mounted.

### Replica dispatch and idle database pressure

The worker uses one dispatcher per replica. Empty queues have
one jittered poll every 2–3 seconds per worker, regardless of processing-slot count.
A successful claim lets the dispatcher fill the resource-derived slots, with at most
two concurrent claim transactions (matching the restricted queue pool's ceiling).
An empty result or claim error puts all slots behind the same polling delay; completing
several jobs cannot trigger an empty-poll storm. Reservations still happen before
claims. SIGTERM stops new dispatch while already-issued claims/jobs may finish.

This reduces idle **claim polling**, not all database work: metrics, heartbeat renewals,
publication and application queries remain. It is not per-user fairness, distributed
connection budgeting or proof of large-scale throughput. A 56-slot worker's empty
polling count falls from 56 per interval to one, but end-to-end database load must
still be measured. Validate scheduler changes in the candidate image and measure end-to-end database
load; aggregate expected polling counts are not measured throughput.

## Initial footprint and scale-out

`settings.json` bounds the service at one node and one instance by default. It does
not start infrastructure by itself. With the current XS resource profile, automatic
capacity derives two heavy processing slots and eight chunk slots per instance.
Durable queued work waits in Postgres; local admission can return retryable 429s.
There is no fixed pool-wide completion cap. Larger configured families must update
both container resource limits and pool sizing, and require validation.

Increase both `maxNodes` and `maxInstances` to permit Snowflake autoscaling; resource
requests in the spec allow service instance scaling to drive node scaling. Merely
adding nodes does not create more service instances. Personal defaults stay at one.
Existing per-user upload admission remains configurable; the service disables the old
eight-session global cap and uses per-owner admission locks. This is not an unlimited
throughput promise: Postgres, stage traffic, gateway ingress, quotas and account limits
still require load tests and eventual partitioning.

## Durability and instance loss

- Upload IDs, frozen metadata, chunk hashes and staged chunk paths are in Postgres.
- Chunk bytes live in the internal Snowflake stage, accessible to every instance.
- Any instance can accept the next chunk, status, cancel or completion request.
- Completion claims use row locks, unique tokens, five-minute leases and heartbeats.
- After a lost instance, a client retry can reclaim an expired lease. The old token
  cannot publish. Completion and its result commit together, so a lost response can
  be retried without a second catalog entry.
- Temporary local video assembly is disposable. A retry reconstructs it from staged
  chunks. No sticky sessions or cross-request local files are required.
- Cancellation deletes the shared session and fences a worker's later publication.
- Failed attempts retain cleanup intents. Existing app cleanup owns their removal.

The browser must remain available to send missing bytes. After completion admission
has durably queued processing, the server finishes accepted work without the tab.
Unfinished browser transfers require file reselection after reopening. AI descriptions
remain on the app's durable recovery loop; upload replicas do not launch face, OCR,
video conversion, search-sync or maintenance loops.

## Build and provision

From the repository root:

```sh
node workers/upload-cpu/render.mjs
# Build context is explicitly allowlisted; local secrets/artifacts are excluded.
docker build --platform linux/amd64 -f workers/upload-cpu/Dockerfile -t stillmark-upload:test .
node workers/upload-cpu/smoke.mjs
```

The renderer generates ignored `dist/spec.json` and `dist/provision.sql` without
executing anything. Build and publish a uniquely versioned image to the existing
Snowflake image repository, set that image in settings and rerender. Review the SQL,
then provision using the Snowflake CLI. No query warehouse is assigned to this service.
The upload role needs stage read/write, the existing Postgres egress integration,
the scoped app Postgres secret and gateway signing secret, and read-only user/grant
metadata visibility. It receives no warehouse grant or maintenance secret.

Provisioning is create-only for safety. Subsequent updates require an explicit
`ALTER SERVICE ... FROM SPECIFICATION` and updates to service and pool scaling bounds.
Verify the configured external-access integration permits the mounted secrets and
storage endpoints in the actual account before first deployment.

## Required canary before routing production

1. Verify SPCS readiness, gateway-role endpoint access and signed identity validation.
2. Use an isolated test album: photo, video, duplicate chunk, changed chunk, unauthorized
   album, revoked session, cancel and lost completion response. Compare metadata and
   originals with the existing route.
3. Run at least two service instances. Send chunks to different instances, terminate
   the completing instance, retry after lease expiry and verify exactly one catalog
   result. Test removal during chunk write and a staged-object cleanup retry.
4. Measure upload throughput, memory, CPU, stage operations and zero warehouse starts.
   Run normal application browsing while uploads are active.
5. Set `UPLOAD_SERVICE_ORIGIN` to the verified Snowflake ingress origin and only then
   set `UPLOAD_SERVICE_ENABLED=true` in the gateway's authoritative config template.
   Render and deploy the gateway. The URL and client upload protocol do not change.

Invalid destinations fail closed. Failed writes are never automatically forwarded to
another backend. Rollback requires a coordinated release; both services share the same
sessions and stage chunks, so users can resume through the app. Keep both versions
schema/protocol compatible during the transition.

Local unit/SQL tests do not prove Snowflake live routing, ingress limits, autoscaling
or failure recovery under real node termination. Those canary checks are release gates.

## Resource metrics

The generated specification enables `system`, `system_limits`, and `status`
platform metrics for CPU, memory, configured limits and container health. These
are written to the account event table and visible in the service Metrics tab.
Telemetry ingestion/storage and querying may incur charges; this is not free
application compute. Apply specification updates only after active uploads drain,
because service updates can restart containers.

## Upload lifecycle

Upload transfers and processing use the
dedicated CPU_X64_XS pool. Opening Upload requests resume; fifteen minutes without active
transfers or queued/processing work initiates suspension, independently of whether
the browser dialog remains open.

See [upload pool lifecycle](../../docs/architecture/upload-pool-lifecycle.md) for
admission locking, error handling, idle-clock behavior and coordinated rollout.
