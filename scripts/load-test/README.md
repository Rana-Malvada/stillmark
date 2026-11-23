# Isolated upload load harness

This is a local, single-generator baseline for the real upload HTTP protocol. It
is not evidence of production capacity, a browser recovery test, or a distributed
100,000-user test. Production routing, scaling, and infrastructure are unchanged.

Run checks with `npm run test:load-harness`. Node 22 or newer is required.

## Prepare an isolated environment first

Execution intentionally fails closed until a **separate test control service** or
a trusted operator provides a fresh signed isolation attestation. The control
service is not implemented here and must never become a production bypass.
It must verify the dedicated writable test database, internal stage, app service,
private fixture albums, and disabled AI/batch dispatch before issuing a token.
A signature proves the control service's assertion, not database isolation by
itself. Never sign assertions without checking the deployed environment.

Use disposable authenticated test users, each with a distinct private album and
an assigned folder. Use synthetic media only. Do not reuse production cookies,
private photos, production stages, or a read-only database replica. Isolate billing
and set a budget before provisioning the future test environment. This script does
not provision resources or disable paid AI itself.

## Configuration

Keep inputs and outputs under the git-ignored `.load-tests/` directory. Create
`actors.json` with permissions `0600`:

```json
[
  { "username": "load-user-1", "eventId": 1, "cookie": "SESSION_COOKIE_FROM_TEST_LOGIN" },
  { "username": "load-user-2", "eventId": 2, "cookie": "SESSION_COOKIE_FROM_TEST_LOGIN" }
]
```

Create `config.json`; paths resolve relative to it. Replace the fixture hash with
the SHA-256 of an actual synthetic JPEG. Fixtures must have unique contents within
each user's upload, otherwise duplicate detection invalidates processing results.

```json
{
  "origin": "https://isolated-upload.example.test",
  "runId": "upload-baseline-001",
  "users": 2,
  "filesPerUser": 1,
  "maxRequests": 8,
  "maxSeconds": 120,
  "rampSeconds": 5,
  "pollMs": 1000,
  "maxBytes": 20971520,
  "actorsFile": "actors.json",
  "fixtures": [{ "path": "synthetic-001.jpg", "sha256": "REPLACE_WITH_64_HEX_DIGITS" }]
}
```

```sh
node scripts/load-test/run.mjs .load-tests/config.json
# Only after preparing and verifying isolation; supply the key through your secret environment:
node scripts/load-test/run.mjs .load-tests/config.json --execute
```

Default dry-run validates local files, hashes, actors and budgets with **no network
requests**. Execute requires `LOAD_TEST_ATTESTATION_KEY` of at least 32 bytes.
Never put its value in a committed configuration or command history.

## Attestation contract

The test control endpoint receives
`GET /__loadtest__/attestation?runId=...&nonce=...` and returns:

- `payload`: base64url-encoded UTF-8 JSON.
- `signature`: hex HMAC-SHA256 of that encoded payload, using the shared key.

The payload binds `runId`, `nonce`, exact HTTPS `origin`, `databaseId`, `stageId`,
`appService`, and `expiresAt` (Unix milliseconds). It must assert `isolated`,
`aiDisabled`, and `batchesDisabled` as true, authorize `maxUsers`, `maxFiles`, and
`maxBytes`, and list `actors` with `username`, `eventId`, `privateFixture: true`.
Expiry must cover the configured duration and be no more than about one hour away.
The known production domain and its subdomains are rejected; other production
endpoints still require the control service to refuse attestation. Redirects fail.
All `/api/auth/me` identities are checked before any upload starts.

Before issuing an attestation, capture a fresh single-statement `DESCRIBE
APPLICATION SERVICE` JSON result and run:

```sh
node scripts/load-test/app-readiness.mjs DESCRIPTION.json GENERATED_APP_MANIFEST.json
```

The check requires a running, non-upgrading one-instance test app, the restricted
role, expected repository/package and warehouse, automatic resume disabled, and
`APP_ORIGIN` matching the provisioned endpoint. It rejects stale result files. A
CLI message saying “App ready” can mean only that an endpoint exists, including
when the service is suspended. This check is not a replacement for verifying the
database guards, actors, worker and disabled background work.

For an operator-verified baseline, `attestationFile` may point to a private (0600)
local envelope instead of the control endpoint. It must also contain `issuedAt`
(Unix milliseconds, at most 60 seconds old) and a fresh `nonce`. Verify the live
database guards, fixture ownership, worker specification and applied app manifest
before signing. App Runtime does not expose the applied specification through
DESCRIBE, so preserve the exact manifest and deployment evidence.

Application endpoints use `Authorization: Snowflake Token="…"`, as in the working
gateway, not the Bearer format used by Snowflake REST APIs.

An actor may use `token` for a restricted, disposable Snowflake PAT instead of
`cookie`, never both. Keep credentials private and disable test users after testing.

## Workload and measurement

Each virtual user transfers one file at a time in 8 MiB chunks, then enqueues it
using `/api/upload/complete`. Queued processing is independent of the transfer.
The harness polls `/api/upload/status` after that user's transfers finish.
It requires exactly one saved result per file in the intended album; duplicate or
synchronous responses fail the baseline. It does not automatically retry requests,
so throttling and failures remain visible. It does not emulate browser thumbnails,
four parallel browser transfers, tab recovery, or session renewal yet.

The global request limit also bounds simultaneous chunk reads/buffers. Each run
is limited to 5,000 virtual users, 100,000 files, 256 in-flight requests, a byte
budget, and one hour. These are generator safeguards, **not app capacity limits**.
Increase load only after checking generator CPU, memory, network and disk, as well
as database connections and app/worker saturation. The harness does not collect
those infrastructure metrics yet.

Private `events.jsonl` and `summary.json` are written under `.load-tests/RUN_ID/`
without overwriting existing runs. The summary also retains the first 100 request
errors independently of the normal 5,000-request sample cap, including endpoint,
phase, elapsed time, and a sanitized failure category. It reports whether that
error sample was truncated; exception text, credentials, and response bodies are
never included. They contain exact upload and album IDs for
reconciliation, but no cookies or server response bodies. Request samples in the
summary are capped at 5,000; the journal retains all request metrics. The byte
counter measures attempted payload bytes, not TCP/TLS overhead or confirmed bytes.

`transferMs` includes request queueing at the generator. Request records separate
`generatorWaitMs` from HTTP duration. `acceptedToCompletionObservedMs` and
`firstProcessingObservedMs` are **polling observations**, not exact queue or worker
times. Processing can finish before polling starts. Join upload IDs to isolated
server claim/completion timestamps to obtain authoritative queue and processing
latency. Do not infer worker throughput from client polling alone.

A deadline, interrupt, auth failure, or preflight failure stops new requests and
waits for local tasks to settle. Already accepted server jobs may still finish.
There is no broad automatic cleanup: reconcile the journal against the isolated
queue and delete only this run's fixtures/resources after workers have drained.
Exit status is nonzero unless every planned file completes successfully.

## Next stage

Implement the isolated control-plane verifier and authoritative timing collector,
then run small cloud baselines with synthetic media. Add four-transfer browser
workload parity, recovery tests and multiple coordinated generators before larger
capacity trials. A 5,000-user result alone must not be extrapolated to 100,000.

## Server timing recorder

`install-telemetry.sql` is an operator-run fixture installer, **not** an application
migration. It refuses any database whose name does not start with
`stillmark_loadtest_`, and refuses a database containing photos or processing jobs.
Use an empty schema-only test database; do not apply it to the production database.

The installer adds a restricted `loadtest_control` schema. An elevated test operator
registers a finite `runs` entry (`run_id`, `expires_at`) and `actors` entries
(`run_id`, `owner`, `event_id`) for existing private fixture albums. Queue writes
outside those owners/albums fail. New uploads after run expiry fail; already accepted
jobs can finish and retain timing records. A test-only photos trigger fills a synthetic
AI description on insert/update so these photos cannot enter the description AI queue.
This does not disable other batch launchers: those must also be disabled and verified
in the isolated deployment, with no production storage or credentials available.

The transition trigger records queued, processing, retry/reclaim, done and failed
transitions using the **database clock**. Heartbeat-only updates add no records. Its
writes commit or roll back with the queue transaction. The trigger adds measurement
overhead; timings describe instrumented database state transitions, not CPU execution
or transaction commit duration. Never install it on production to obtain a benchmark.

After a run, collect timings using an explicit isolated Postgres environment
(`PGHOST`, `PGDATABASE`, `PGUSER`, secure credential/TLS settings supported by node-postgres):

```sh
node scripts/load-test/collect-timings.mjs \
  .load-tests/upload-baseline-001/summary.json \
  .load-tests/upload-baseline-001/server-timings.json
```

The collector refuses production-style database names and read replicas, uses a
read-only transaction, selects only the run's exact upload IDs, and creates a new
private output file. It reports each attempt separately, including retry and expired
lease intervals. A reclaimed attempt's duration includes lease expiry; it is not an
estimate of CPU time. Incomplete transitions remain incomplete rather than appearing
as zero latency. No credential or raw database error is printed on failure.

Initial infrastructure discovery found only the production database instance and
production Application Service. The suspended foundation described below is the next
provisioning stage. The cloud baseline remains pending a complete isolated runtime;
local recorder tests are not a cloud throughput result.

## Separate build and suspended foundation

The runtime imports `config/deployment.json` at build time. A production worker image
must not be reused with only a different `PG_HOST`: its stage/catalog bindings would
still refer to production. `isolation-profile.mjs` creates a separate compiled profile,
App Runtime manifest and worker specification. It rejects the production Postgres host,
production App Runtime origin, and images from the production repository.

`provision-foundation.sql` creates only the fixed `STILLMARK_LOADTEST_BASELINE` namespace,
empty internal stages, image repository, limited storage role, one-node XS upload pool,
and an XS development warehouse. Both compute resources are initially suspended with
automatic resume disabled. It is deliberately not idempotent: a naming collision must
be inspected rather than silently adopting someone else's resources. It creates no
Postgres instance, app service, credentials, EAI, test users or background tasks.

Once the isolated Postgres host and App Runtime origin have been established, supply
an uncommitted target JSON with `suffix: "BASELINE"`, `pgHost`, and `appOrigin`, then run:

```sh
node scripts/load-test/render-stack.mjs .load-tests/target.json
```

The renderer exports committed Git source into a new private directory, replaces the
compiled profile and app manifest, and writes an isolated worker spec. It refuses to
overwrite an existing stack directory. It does not run Snowflake commands or deploy.
Build the worker from that exported source and push it to the isolated image repository;
the output records the source revision and intended image tag.

These are preparation artifacts, not a complete deployment recipe yet. The dedicated
writable Postgres schema, narrowly scoped credentials/network access, App Runtime build
repository/EAI, restricted execution role, authenticated synthetic users, routing row
(`route='pool'`), and live isolation verifier still need provisioning and validation.
The app manifest disables local queue processing and all background loops; the separate
worker processes the test queue. No autoscaling policy is enabled for this small baseline.
The test-only database AI guard remains required even with background loops disabled.
Deploy under the isolated runtime role with `--role`; do not use ACCOUNTADMIN as
the app owner. `execute_as_role` is not accepted in a standard database. App Runtime
requires an idle timeout of at least 300 seconds (or zero); the generated manifest
uses 300 with automatic resume disabled. Explicitly suspend test services, the pool
and Postgres after the run, including failed setup attempts.

`bootstrap-postgres.py` restores a schema-only archive into the dedicated writable
test instance, creates restricted database roles, installs telemetry/AI guards,
and saves fresh app/queue passwords privately. It deliberately fails if the
database already exists; it does not copy production data or reset an existing test.

Private `.load-tests` files are also excluded from the production App Runtime bundle,
not just Git. The upload Dockerfile already uses a source allowlist that excludes them.

## Networking and resume behavior

The renderer writes `isolated-network-rules.sql` for Postgres and customer data-stage
egress. Do not add `RUNTIME_STORAGE_HOST` (the managed artifact access-point host)
to those external-access rules. Keep managed artifact traffic on the platform path
and data-stage traffic in its explicit egress rule. Verify startup and data access
for the candidate environment; record results privately.

Disabling a test user automatically disables its PATs. Resuming a finite test requires
explicitly re-enabling the restricted PAT as well as its user, after verifying the
network policy and role. Disable both again when done. The timing collector loads
`PGSSLROOTCERT` explicitly because node-postgres does not load that libpq setting.

## Bounded backpressure retries

The harness defaults to strict failure on HTTP errors. Cloud concurrency runs may
set `retry429` to an integer from 0 to 10 to retry admission backpressure. Retries
wait outside the request-concurrency gate, use Retry-After with jitter (bounded to
about two minutes per wait), and retain every 429 in the status counts. Every
retransmitted body counts against the same byte budget; provision explicit retry
headroom in both configuration and attestation. Authorization errors, other HTTP
errors, deadlines and exhausted byte budgets still fail the run. This exercises
429 recovery, not every browser recovery path. A passing file-completion result
with 429 responses must not be described as an error-free HTTP run.

`node scripts/load-test/check-upload-locks.mjs` verifies the ingestion lock protocol
against an explicitly configured isolated Postgres (`PGHOST`, `PGUSER`, `PGDATABASE`,
`PGPASSWORD`, `PGSSLROOTCERT`). It uses three real sessions and transaction locks,
without catalog writes: different albums overlap, same-album writes serialize,
management excludes uploads in both directions, and rollback releases locks.

### Isolated worker image builds

Build the upload Dockerfile with the **rendered isolated source directory** as its
context, never the production repository root. `lib/snowflake/storage-constants.ts` reads
`config/deployment.json` through the deployment module; environment overrides do
not replace those compiled storage names. Before building, verify that context's
`DATABASE` starts with `STILLMARK_LOADTEST_` and `PG_DATABASE` starts with
`stillmark_loadtest_`. The isolated role must remain restricted to that namespace.
For example, from the repository root:

```sh
docker build --platform linux/amd64 -f workers/upload-cpu/Dockerfile \
  -t ISOLATED_REGISTRY_TAG .load-tests/ISOLATED_PROJECT/source
```

Before load generation after any rollout, verify authenticated HTTP readiness as
well as control-plane status and worker image digests. A RUNNING service can still
briefly return HTTP 503 while its ingress finishes updating.

### Bounded cloud-generator capacity

The cloud service keeps its existing defaults (250 actors, 256 simultaneous
requests, 4 GiB read budget). Operators can opt into a larger isolated profile
with `LOAD_TEST_MAX_USERS` (maximum 5,000), `LOAD_TEST_MAX_REQUESTS` (maximum
1,024), and `LOAD_TEST_MAX_READ_BYTES` (maximum 16 GiB). Client-supplied plans
cannot increase these server-side ceilings. Per-run upload, file-count, duration,
request-count, and process-lifetime transfer budgets still apply; increasing a
ceiling does not provision capacity or prove a workload passes.

Mixed-run summaries include `timedPhaseStartedAt`, `measurementStartedAt`, and
`measurementEndsAt` so platform samples can exclude authentication/isolation
preflight and warmup. The last value is the scheduled measurement end; failed or
canceled runs must still pass the sustained-overlap and functional gates before
being treated as capacity evidence.

Before a repeat capacity run, verify that earlier isolated upload jobs have drained
and that the fixture actors have no abandoned receiving sessions (`result IS NULL`
with no matching processing job). Cancel abandoned fixture sessions through the
normal authenticated upload cancellation endpoint. Do not delete production
sessions or remove admission limits to make the test pass. Leftover sessions count
against the per-user upload limit and can cause unrelated HTTP 429 failures.

`assessMixed(result, database, limits, { cpuCores })` accepts CPU allocation verified
from the generator service specification. Omission retains the one-core default.
Use the guaranteed allocation, not the host's total cores, and retain the allocation
evidence with the run. The CPU gate remains 80% of allocated capacity over ten-second
windows. This is process CPU headroom, not a guarantee that its JavaScript main
thread or transport is unconstrained. Latency, generator queue, memory, errors and
durable completion must also pass. Never infer allocation from workload output.
