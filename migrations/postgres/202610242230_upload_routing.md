# Upload routing and drain admission

Additive migration only; no existing upload/session data changes and no compute
starts or stops. Initial state matches the current pool routing. Ordinary app
connections may read the route but cannot change it; request bookkeeping is
owner-scoped. Only the main-admin API invokes the maintenance credential to change
routing. The worker never receives that credential.

Do not apply during the current upload. After backup verification, apply before
shipping managed-routing code. Rollout details are in workers/upload-cpu/README.md.
