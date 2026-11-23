# Dedicated upload pool lifecycle

## Behavior

All chunk transfers and upload completion requests go to the dedicated upload
service. The web app rejects these operations; its queue worker is disabled. The web app still
handles authentication, upload intent, and read-only upload status. Startup failures are reported without changing the transfer destination.

Opening Upload sends one authenticated, same-origin POST to request startup.
Concurrent files in that browser share startup readiness work. Read-only GET polls
wait for readiness; they do not reset the idle clock. Selecting files later requests
readiness again. Cancellation stops the caller waiting without canceling another
file's shared startup.

Leaving the dialog or upload page open after completion does not keep the pool
awake. Status requests run on the web app/Postgres and do not start the upload service.
Actual processing is never performed by the web app.

## Fifteen-minute shutdown

The elected application background coordinator checks durable Postgres state every
ten seconds. No Snowflake query is made while stably running or suspended.
Completed admitted transfers and actual queue-row changes update the activity time.
Zero-row worker polls and read-only status polling do not update it.

Only after 900 seconds without activity, and with no admitted requests or queued/
processing upload jobs, the controller takes the exclusive admission lock,
rechecks the conditions, and closes admission. HTTP handlers and queue claims use
the shared counterpart. The controller then suspends the service and pool, checking
Snowflake's reported states. This initiates shutdown within one healthy polling
interval after the threshold; infrastructure shutdown itself takes additional time.

The controller survives browser closure. Background coordination must remain
enabled on at least one web app process. Database/controller failure delays suspension
rather than risking unfinished work. Unclean worker exits can leave request records;
these deliberately block suspension until an operator verifies the work stopped.
A startup error is shown on Upload; opening Upload again retries startup.
The former Activity upload-processing tab is removed; old bookmarks redirect to Activity.

The generated pool configuration uses AUTO_SUSPEND_SECS=900 as a secondary safeguard for a pool with no
running services. It cannot substitute for queue-aware shutdown while the service
is still running. Both service and pool AUTO_RESUME remain false so stray status
requests cannot wake them. The controller explicitly resumes them on upload intent.
See [Snowflake ALTER COMPUTE POOL](https://docs.snowflake.com/en/sql-reference/sql/alter-compute-pool).

## CPU and deployment

The upload pool configuration selects CPU_X64_XS. The worker spec derives CPU,
memory, threadpool and concurrency budgets from that family. Existing node and
instance limits remain one; automatic scale-out stays disabled.

This change requires a coordinated release, not just a frontend deployment:

1. Wait for uploads and upload jobs to drain; verify backup and migration checks.
2. Stop the old routing controller during cutover. Suspend the upload service and
   pool, and verify SUSPENDED before changing instance family.
3. Apply 202611011800_upload_pool_idle.sql using the migration runner. It removes
   obsolete routing states and adds activity tracking. Use a schema-compatible controller.
4. Set the existing pool's INSTANCE_FAMILY=CPU_X64_XS (unchanged), plus
   AUTO_RESUME=FALSE and AUTO_SUSPEND_SECS=900. CREATE IF NOT EXISTS will not resize
   an existing pool. Build/push a fresh worker image, update settings' image tag,
   render and apply its specification with the XS resource budgets.
5. Deploy the web app and the gateway together, preserve scoped runtime MONITOR/OPERATE
   permissions, and ensure upload_routing.enabled and UPLOAD_ROUTING_MANAGED are
   true. Gateway UPLOAD_SERVICE_ORIGIN must be configured. All transfer requests use the dedicated upload service.
6. Verify authenticated startup, unauthorized denial, one real upload, queued
   completion, and idle suspension with the completed dialog left open. Verify
   both service/pool SUSPENDED and zero active nodes. Reopen Upload and verify
   readiness before transfer. Do not enable load-test infrastructure for this check.

Rollback must coordinate app, worker, gateway and schema; do not switch the gateway
back to the web app, since this version intentionally rejects web app uploads.

## Local validation

Tests cover the fifteen-minute boundary, active-work blockers, admission race recheck,
failed control calls, container readiness, web app rejection, browser request coalescing,
cancellation, an open idle dialog, read-only status polling, and migration triggers/
row-level security. These are local tests; live lifecycle validation belongs to the
authorized release.

The XS release retains the existing native pool idle setting when MODIFY is unavailable.
The application controller still explicitly suspends the service and pool after fifteen
idle minutes; it does not depend on the native timer.
