# New-account notifications

Adds `photo_security.recent_public_signups()`, a read-only SECURITY DEFINER
function executable only by the maintenance role. It returns the opaque marker,
creation time and display name of accounts self-registered in the last 48 hours
(oldest first, at most 200). It does not return email addresses, login subjects
or usernames, and changes no rows.

The signed `/api/health/monitor` endpoint includes this list as `recentSignups`.
The gateway's `EmailAlerts` Durable Object sends one email per new account to the
configured alert recipient and remembers which markers it has already reported.
See [email alerts](../../docs/EMAIL-ALERTS-SETUP.md).

Deploy this additive migration before the application. The application omits
`recentSignups` when the function is unavailable, so database health reporting is
unaffected in either order, and the gateway ignores a missing list. Keep the
migration installed if the application or gateway is rolled back.

Verification: `tests/monitor.test.ts` executes the function and the endpoint
against PGlite, including the 48-hour window and the excluded columns.
`cloudflare-gateway/signup-notices.test.mjs` covers first-run baselining, one
email per account, retry after a failed send, the per-check send limit and
rejection of malformed records.

Read-only installation check:

```sql
SELECT pg_get_functiondef('photo_security.recent_public_signups()'::regprocedure);
```
