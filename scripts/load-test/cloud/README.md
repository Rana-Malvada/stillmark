# Bounded cloud upload generator

This test-only service runs the existing upload harness on a separate compute-pool
node. It does not replace the app, worker or browser. It exercises authenticated
HTTP chunk upload, queue admission and completion polling.

Build using a private context containing `harness.mjs`, `transport-trace.mjs`,
`mixed.mjs`, `http-failure.mjs`, `cloud/server.mjs`, this Dockerfile and a `fixtures/` directory. Fixtures must be synthetic JPEGs with a
`manifest.json` array of `{name, sha256}` entries. No credentials belong in the
image. At startup every fixture is hash-verified.

Deploy only in the isolated test namespace, behind authenticated Snowflake public
ingress. Restrict its EAI to the exact test App Runtime hostname and grant endpoint
access only to the test operator role. Set `LOAD_TEST_ORIGIN` to that HTTPS origin.
The generator needs no database credentials. Test-user PATs must permit the cloud
source IP ranges; do not alter production user network policies.

After independently verifying app readiness, test database guards, ownership,
empty queue and disabled AI/batches, POST `/run` with `config`, `actors`, `key` and
`attestationEnvelope` as defined in the parent harness. The operator signs a fresh
attestation immediately before submission. Do not log this request body.
GET `/result/<runId>` returns progress or the completed summary and generator CPU
and memory samples. Save results privately before replacing the generator.

Budgets per process lifetime:

- One active run; no run-ID reuse; at most eight runs.
- At most 250 users, 1,000 files, 256 concurrent requests and 900 seconds per run.
- At most 4 GiB planned transfer per run and 16 GiB across all runs.
- At most 1 MiB control request body.

The underlying harness verifies the signed attestation and every user identity
before uploading. Per-user transfers remain serial; this is not yet a simulation
of four concurrent browser transfers per user. Results live in generator memory,
so an unexpected generator restart loses local evidence; database transition
telemetry remains the source of durable processing evidence. Fetch each run result
before proceeding. Generator state and lifetime budgets reset on restart.

## Recovery image

`Dockerfile.fault` derives from the exact tested worker image and adds only a
supervisor. Pass that image as `WORKER_IMAGE`. Never deploy this derived image to
production. It requires the exact isolated database/namespace and explicit
`LOAD_TEST_CRASH_ONCE=true` and diagnostic flags.

On the first diagnostic `claimed` event it stops and SIGKILLs the child worker,
records the upload ID, then restarts the child once. The supervisor remains alive;
this tests abrupt **worker process** loss, not loss of an entire node or Postgres.
The normal lease timeout must expire naturally before the orphaned claim can be
recovered. Do not shorten or manually expire leases to make the test pass.

Restore the original worker image after the recovery run. Verify all upload IDs,
attempt transitions, photo publication counts and empty AI ledgers. Automatic
scaling remains disabled until the agreed recovery and scale-out checks pass.

`capture-retries.sql` adds an isolated retry-error audit without changing worker behavior.
Install before a run to retain errors that the normal job row clears after success.
It requires the existing test transition guard and refuses other databases.

The current image supports `fixtureSet: "standard" | "large"`; manifest entries may
set `group` (default `standard`). Each set is independently hash-verified. POST
`/stop/<active-run-id>` aborts the active generator run; already admitted jobs remain
durable and drain through the workers. The operator stops further ramp stages on
errors or a 400-connection threshold in the 500-connection test database.

### Correlating HTTP stalls

The generator assigns a unique `x-load-test-request` ID per attempt and records
numeric Undici lifecycle timings (created, headers/body sent, response headers,
response completed), plus a process-local socket number/reuse count. No request
headers, response bodies, exception text or network addresses are retained.
Upload attempt IDs use a zero numeric prefix and random remaining UUID bits so
they are retained even when the isolated app samples browsing requests. This
allows chunk admission and storage stalls to be correlated without enabling
full tracing for all browsing traffic. Timeouts remain failures; tracing does
not add retries or extend the deadline.

For isolated app diagnostics only, set `UPLOAD_REQUEST_TRACE=true` alongside an
explicit `PG_DATABASE=stillmark_loadtest_...`. Upload route logs then emit the same
ID on handler entry, every five seconds while pending, and handler return, with
request-body/authentication/database-checkout timings. The direct stdout records
contain only the fixed event schema; normal production log filtering remains
unchanged. Returning a Response from the handler is **not** proof the client
received it; compare it with the generator's response-header and body events.

Read logs from **each** app instance using
`SYSTEM$GET_APPLICATION_SERVICE_LOGS('<isolated app>', <tail lines>, <instance>)`.
The default is instance zero. Capture promptly after the bounded test so the tail
includes the relevant IDs. Keep raw logs and credentials in ignored private test
artifacts. Do not enable this flag on production or infer the source of an HTTP
stall solely from a client-side timeout.

Recovery mode is explicit: `retryTransient` (0–3, default zero) enables bounded
retries for network timeouts and HTTP 408/425/500/502/503/504, reusing immutable
chunks and the original upload ID. Authentication/permission errors still stop
the run. Retries count against byte/time/request limits. Every failed attempt
remains in `requestErrors`; `passed` means all planned files completed, while
`cleanRequests` separately reports whether there were zero request errors.
A completed cached result from `/complete` is valid after a lost response.

`loseCompletionResponses` (0–10, requires recovery mode) deliberately discards
that many successful queued completion responses in the generator, after reading
them. It leaves the real server/queue untouched, then retries the same request.
Injected errors are labeled `injected_response_loss` and counted separately so
they cannot be mistaken for platform failures. Reconcile every accepted upload
against distinct catalog photos to prove recovery did not duplicate publication.

## Mixed browsing and uploads

Set `workload: "mixed"` and explicitly configure `uploadUsers`, `uploadRounds`,
`durationSeconds`, `warmupSeconds`, `thinkMs`, `readRequestBudget`, and `maxReadBytes`.
The mix describes concurrent personas, not an exact HTTP request percentage.
Browsing repeatedly fetches owned album lists and their next page, available
album-cover thumbnails, photo lists and their next page, two photo thumbnails,
photo details and display-image bytes. Responses are fully consumed and checked.
This is HTTP workload simulation, not browser rendering or a Cloudflare/Auth0 test.

Each actor has a distinct private `browseEventId`. Upload actors additionally have
`uploadEventIds`, one distinct empty private album per round, with the first equal
to `eventId`. The operator must verify and sign every upload round and browsing
album before submission. Derived upload attestations narrow this existing scope;
they do not authorize new fixtures. Register each round in the existing isolated
transition/AI-suppression guard. Never reuse production users or media.

Reads have separate signed request and byte budgets. Cloud runs cap reads at
4 GiB and 100,000 requests; combined read/upload reservations count against the
existing 16 GiB process-lifetime budget. Uploads still have their separate 4 GiB
ceiling. All requests remain on the configured isolated origin and redirects are
rejected. Identity mismatch or private-fixture exposure stops the run.

Warm-up, measurement and drain are reported separately. Per-operation logarithmic
histograms retain every latency sample; queue wait inside the generator and total
latency are reported too. Uploaded files are distinct across rounds by album;
rounds are finite. If upload fixtures run out before the measurement window ends,
`capacityEligible` is false even when functional checks pass. Do not describe such
a run as sustained mixed capacity.

`mixed-gates.mjs` provides provisional gates: API p95/p99 <= 1/2 seconds, image p95/p99 <=
2/4 seconds, generator queue p95 <= 50 ms, at least 20 samples per measured operation,
no functional errors, database connections below 400 of the isolated 500 limit,
upload backlog <= 1,000, oldest queued/processing upload <= 180 seconds,
queue drained, generator CPU below 80% over 10-second windows and RSS below 4 GiB.
The database sampler includes `oldestUploadAgeSeconds`; historical evidence without
this field or p99 measurements fails the current gate. Generator timestamps and
cumulative CPU counters must advance without resets.
Database and generator samples must span the reported measurement window with
no gaps over 10 seconds. Start sampling before the workload, continue through
drain, and use synchronized clocks; a lone final drained snapshot cannot pass.
These are initial test criteria, not promised production SLAs. Keep resource
placement fixed and verify durable upload outcomes independently before increasing
load. A passed HTTP run alone does not establish a safe capacity.

For failed reads, the mixed runner consumes at most a small bounded error body
and retains only fixed diagnostic categories (`authentication_busy`,
`upstream_unavailable`, or `http_error`). It does not retain provider text or
credentials. Aborted upload work cannot overwrite the original browsing failure.
These diagnostics do not retry requests or change the offered traffic.

Use `node scripts/load-test/summarize-mixed.mjs PRIVATE_RUN_DIRECTORY` for offline
assessment. The directory must contain `cloud-result.json`, `db-samples.json`,
and independently collected `durable.json` counts. HTTP completion alone is not
sufficient: jobs, completed jobs, distinct upload IDs and published photos must
agree, with no AI REST requests. Album-cover latency is included in the image gate.

### Capacity runs without transport diagnostics

Set `LOAD_TEST_TRANSPORT_TRACE=false` on the generator to omit the per-request
AsyncLocalStorage/Undici lifecycle diagnostics during capacity measurements.
Request IDs, status codes, deadlines, end-to-end latency, response-byte budgets,
identity/isolation checks and generator CPU/memory samples remain enabled.
Leave the flag unset for detailed transport investigations. Record the setting
with results; do not compare diagnostic and capacity runs as identical workloads.

`GET /health` includes the configured `TEST_CYCLE` and process startup time. After
replacing a generator, require the expected cycle before sending `/run`; an old
container can briefly answer healthy during a rolling replacement. Never retry a
start request until the run ID is confirmed absent.

### Controlled client-transport diagnosis

`LOAD_TEST_HTTP_PROTOCOL=native` is the unchanged default. `h1` and `h2` opt into
an explicit Undici connection manager while keeping Node's native fetch and
multipart encoding. `LOAD_TEST_HTTP_CONNECTIONS` bounds sockets per origin
(default 640 for h1, 8 for h2; maximum 1024). `LOAD_TEST_HTTP_STREAMS` bounds h2
streams per connection (default 100, maximum 1024). h2 negotiates via TLS ALPN;
verify `transport.protocol` in request evidence rather than assuming negotiation.
The health response and completed result record the requested configuration.

This is a load-generator experiment, not a production application change.
Changing the protocol invalidates a one-variable app performance comparison.
Native and managed modes retain workload deadlines, byte/request budgets,
permission checks and failure gates. The manager adds no retry loop and rejects
cross-origin destinations. Requests cannot follow redirects. Transport timings
include any dispatcher waiting; do not subtract it to improve reported latency.
Use the pinned cloud package lock when building. Native FormData and fetch must
remain paired; mixing the separately installed fetch implementation with native
FormData can encode multipart bodies incorrectly.
