# Read a session's current authority without consuming an assertion

A signed-in request is authenticated once, by a short-lived gateway assertion that can be
used a single time. A ZIP download of many originals keeps running long after that, so
disabling the account, logging the session out or withdrawing a role during the transfer
did not stop the files that had not been fetched yet.

This migration adds one read-only function,
`photo_security.gateway_session_authority(subject, session_id, started_at, check_cutoff)`.
It returns the same row as the sign-in functions (`gateway_app_identity_once`,
`gateway_customer_identity_once`): the linked account, whether the session is revoked or
older than the credential cutoff, and the account's current permissions. Unlike them it
does not insert into `gateway_assertions`, so it can be called again during one request
and never weakens replay protection. `check_cutoff` mirrors the application switch that
selects the customer-account sign-in function.

It is `SECURITY DEFINER` with a fixed `search_path`, revoked from `PUBLIC` and granted
only to `personal_photos_app`, like the sign-in functions it sits beside. It exposes
nothing that login cannot already learn: the sign-in functions return the same row
(account for a subject, revoked or past the cutoff, permissions) to the same login.

No table or row is changed. The migration is additive: an older application version
never calls the function, so it can be applied before the application release that uses
it, and must be (the signed-in ZIP download fails closed without it). Rolling the
application back needs no database change.

Verification: `tests/zip-download-session-authority.test.ts` applies every migration and
runs the real download route under row-level security with signed gateway assertions.

Read-only installation check:

```sql
SELECT oid::regprocedure, proacl FROM pg_proc WHERE proname = 'gateway_session_authority';
```
