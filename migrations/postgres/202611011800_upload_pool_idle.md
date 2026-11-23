# Pool-only upload lifecycle

## Compatibility

Coordinate SAR, worker and gateway rollout after uploads drain. Suspend the old
controller and worker before applying: the old app/pool mode controller is not
compatible with the pool-only constraint. Existing files, sessions and queue jobs
are preserved. The initial suspended state requires the pool to be suspended;
new upload intent resumes it. Only this migration is included in this release.

## Verification

Inspect upload_routing for pool-only route/desired and last_activity_at. Verify
worker empty polls and read-only status requests do not advance the idle clock.
Verify actual request completion and job updates do advance it. The new partial
index confines live-work checks to queued/processing jobs. Local PGlite and lifecycle
tests cover triggers, RLS and the ten-minute boundary. At deployment, verify a full
startup and shutdown with the upload dialog open and a safe empty queue.

## Rollback

Do not restore production data. Keep pool routing and use the new app/worker while
fixing forward. Reverting to the old switch requires a reviewed forward migration
restoring its phase constraint and removing pool-only enforcement, plus a coordinated
app/worker/gateway rollback. Do not run the old controller against this schema.
