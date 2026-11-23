# Session revocation

## Problem and change

The app already resolves every gateway identity using PostgreSQL. That existing
SELECT now includes an indexed EXISTS lookup against gallery_revoked_sessions.
The revocation result is checked before the existing role cache. No extra database
round trip is added. Album permissions remain enforced by the app.

Logout uses a server-signed POST to the app; the session ID comes only from the
verified assertion, never client-supplied JSON. A successful response requires the
revocation write to commit. Database failures do not report successful logout.
Requests whose authorization starts after that commit are rejected, including
copied cookies. Already-authorized requests and already-downloaded bytes cannot
be recalled. Unchecked sign-ins expire after one hour idle and twelve hours absolute.
Optional remembered sign-ins expire 30 days after sign-in. The
`202611180900_remembered_sessions` migration extends new logout records to
30 days plus five minutes and must precede the gateway release.

## Release and verification

Use [forward migrations](SAFE-RELEASES.md) and inspect the current ledger; never replay historical setup files.
Do not roll back PostgreSQL revocation enforcement while affected cookies remain valid.
Test committed logout rejection, a separate still-valid session, replay rejection,
and fail-closed behavior during a database outage. Measure normal browsing/upload
latency under the same workload before and after changes. Keep results in `.release/`.
