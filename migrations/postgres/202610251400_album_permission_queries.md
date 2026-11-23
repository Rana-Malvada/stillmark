# Album permission query optimization

Apply through the checked migration workflow before or alongside the application
optimization. The app code also works with the old policies. No media changes or
cross-request permission cache are introduced. Do not replay legacy setup scripts.

`readable_events` and `editable_events` materialize request constants once inside
each statement. The event read policy checks the indexed event row directly,
using a restricted definer helper for the current user's explicit share IDs.
Photo list policies continue using their per-statement accessible-album set.
The selected-photo public-link restriction is untouched. Main-admin, gallery,
owner, explicit-share and public-link semantics must remain identical.

Security: the new function uses a fixed search path, has PUBLIC execution revoked,
and is granted only to the app role. Existing helper ownership and grants remain
unchanged. No bypass-RLS permission is granted to runtime users. Revocation is
visible on the next statement under the app's existing READ COMMITTED transactions.

Before production: verify backup/restore; pass actual-role security tests and the
isolated four/eight-worker comparison. The migration uses a five-second lock timeout
and must run in the release wrapper's transaction. A lock timeout rolls it back.

Rollback the application independently if needed. For database rollback, restore
`readable_events`, `editable_events`, and the `events.app_read` expression from the
pre-migration definitions captured during release, then drop `shared_events()`.
Do not replay all of `setup/72-app-rls.sql`; it could overwrite subsequent policies.
