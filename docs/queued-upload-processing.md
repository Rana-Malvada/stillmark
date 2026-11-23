# Queued upload processing

## Scope and state

Uploads are received and processed by the dedicated upload service. Resource and
concurrency settings live in `workers/upload-cpu/settings.json`; lifecycle behavior
is documented in [upload pool lifecycle](architecture/upload-pool-lifecycle.md).

The app server handles UI and authorization. The existing upload ingress receives
immutable chunks directly into the Snowflake stage. A new completion request seals
those inputs and commits a Postgres job, returning HTTP 202. Optional video previews
are also staged; binary media is not retained in the queue table. The browser releases
its transfer slot and sends the next file. Image preparation continues independently
of that browser, its page, or the ingress instance that accepted it.

## Ownership, recovery and publication

- Queue primary key is the stable upload UUID. Duplicate completion requests do
  not create extra jobs. Metadata is frozen; all chunk counts, sizes and total
  bytes are verified before acceptance. The worker verifies actual chunk hashes.
- Workers claim one job per free processing slot with `FOR UPDATE SKIP LOCKED`.
  Claims have unique tokens, five-minute leases, and 30-second heartbeats.
  Restarted or removed instances leave recoverable leases, not in-memory-only work.
- Retry transient errors with exponential backoff, at most five attempts. Invalid
  media and permission errors become visible failures. Failed jobs can be retried
  from the existing upload panel without resending retained original chunks.
- Both the queue lease and existing upload-completion lease fence publication.
  A stale worker cannot publish after a replacement owns the job. Catalog rows,
  upload result, queue completion and upload-completed usage accounting commit
  together. Preparation is at-least-once; publication is idempotent. A crash may
  repeat transformation/storage work, but it must not produce duplicate photos.
- The worker uses the accepted caller's identity through the normal app RLS role
  and rechecks album access during publication. Delegation expires after seven
  days; retry requires a fresh authenticated acceptance. Browser credentials/tokens
  are not saved in the queue.
- Any access change advances one global authorization epoch. A job accepted under
  an earlier epoch is not rejected and its stored caller is not used: the worker
  reads the owner's current account state and roles from PostgreSQL
  (`lib/identity/queued-upload-authority.ts`), proceeds only if that owner may still
  upload, and acts with exactly that authority. Publication reads it again inside
  its transaction and requires it to be unchanged, then applies the usual epoch
  fence against the epoch the attempt started under. So another member's access
  change does not stop an upload, while a disabled, deleted or read-only owner
  fails with "Permissions changed; retry this upload after checking access" and
  nothing is published. An access change during processing costs one retry. Where
  roles are held in Snowflake (`APP_PERMISSION_AUTHORITY=snowflake`) they cannot be
  re-read by the worker, so a changed epoch still rejects the job.
- **A suspected account compromise must be answered by disabling the account**, not
  only by resetting its password or ending its sessions. Disabling stops uploads that
  are already queued; a password reset, a sign-out or a revoked session does not,
  because none of them changes what the account is permitted to do.
- Active queue jobs protect upload sessions and staged chunks from cleanup. Completed
  publication retires chunk references through the existing cleanup intents. Failed
  jobs retain chunks until session expiration or explicit dismissal.
- A restricted, separate queue credential dispatches jobs. It cannot read the photo
  catalog or change upload lifecycle state. Missing credentials fail closed;
  there is no maintenance-credential fallback.

## Browser and status

Four network transfers can run while previously accepted files process. The UI says
“Uploaded · processing”; it does not report processing as successful publication.
Status requests batch up to 100 owned IDs. Accepted jobs recover from stored IDs on
reload without requiring original files. Recovery also checks IDs whose acceptance
response may have been lost. A closed browser cannot finish transferring unsent
bytes, but accepted server jobs continue.

Cancel stops further browser transfers. Already accepted processing jobs continue,
as stated in the panel. Dismissal of an unfinished session deletes its durable job
and fences publication. Successful media is retained. Activity separates waiting,
processing, failed, and incomplete receiving counts, polling while work exists.

Old browser clients without the queue protocol marker continue using the existing
synchronous completion path during rollout. Do not remove that path until old
clients are no longer in use.

## Dedicated workers and scale-out

Only upload-service processes consume jobs. Claims use shared admission locking
so shutdown cannot race active work. Expired claims can be recovered by another
worker, with lease tokens fencing stale publication. Opening Upload resumes the
service; read-only status polling does not extend the fifteen-minute idle timer.

`UPLOAD_COMPLETIONS_PER_INSTANCE` controls per-instance admission. Automatic
capacity derives from configured and detected CPU/memory limits. Increase service
instances and pool nodes together after controlled validation. Production automatic
scale-out is disabled. Queue age, CPU, connection pressure and completion latency
are the measurements for a future capacity change.

`UPLOAD_QUEUED_PER_USER` defaults to 1,000 outstanding jobs as a configurable backlog
budget, separate from the four receiving sessions. The pooled receiver keeps the
existing global receiving limit disabled. Queued mode also disables the legacy
60-new-files-per-minute window by default: that window caused fast albums to
pause after exactly 60 files. `UPLOAD_STARTS_PER_USER_PER_MINUTE` can explicitly
set a per-owner budget; zero disables it. Synchronous mode retains the default
of 60. Receiving concurrency and outstanding-job limits remain enforced. There is no queue-wide one-user lock;
owner admission is serialized only for that owner's backlog budget. Dispatch is
oldest eligible job first, not weighted per-tenant scheduling. Database capacity,
existing catalog mutation locks, account quotas, and traffic/load testing remain
required work before very large-scale deployment.

## Batch compatibility

The worker calls the existing `completeUpload` → `ingestUpload` path, retaining file
paths, IDs, ownership, folder selection, duplicate detection, metadata, thumbnail
sizes, and publication contracts. Partial preparation is not inserted as a completed
photo. When `AUTOMATIC_MEDIA_PROCESSING_ENABLED=true`, committed catalog changes
record durable signals for face recognition, video playback preparation, OCR and
search publication. The elected application coordinator admits that work; upload
completion does not wait for inference or search publication. Automatic workers
reuse their process for up to 15 idle minutes within the original run deadline.
Search publishing stops at the original three-hour deadline or on Stop; unfinished
work remains durable. Photo AI descriptions are also automatic, subject to the
[hourly allowances](AI-DESCRIPTIONS.md#hourly-allowances). Manual
batch controls remain available. See the [search worker runbook](../workers/search-cpu/README.md)
for automatic admission, retries and Stop behavior.

Storage reads/writes retain the warehouse-free storage connection. Worker startup
is separate from general maintenance: the upload-only runtime does not start
unrelated batch maintenance loops. Shared Postgres/storage contention still needs
measurement with representative batch workloads before large-scale enablement.

## Release and recovery

Use the [safe release procedure](SAFE-RELEASES.md) and the
[worker lifecycle runbook](architecture/upload-pool-lifecycle.md). Drain accepted
work before replacing worker containers. Keep compatible consumers available until
queued work finishes; never drop queue tables with accepted jobs outstanding.
Validate startup, duplicate completion, lease recovery, authorization revocation,
publication, and idle suspension after a coordinated worker/gateway change.

Schema changes go through the checksummed migration runner. Applied migrations
are immutable historical records, not instructions to recreate an older topology.
