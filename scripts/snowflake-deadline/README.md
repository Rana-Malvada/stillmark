# Scoped Snowflake query deadlines

The locked SDK (3.4.1) does not expose local transport cancellation on statements.
`statement.cancel()` sends a separate server abort request; a timer raced against
`execute()` leaves HTTP retries running. This patch adds two explicit transport
hooks: inherit an async-local AbortSignal when constructing a request, and make
retry backoff interruptible. Axios then aborts the socket and does not retry an
`ERR_CANCELED` request. No SQL, credentials, TLS options, or retry counts change.

`npm ci` applies the patch via postinstall. The installer checks exact original
or patched SHA-256 hashes and the SDK version, and fails on drift. The build
verifies both patched files and the context module in the standalone output.
SDK upgrades require review and renewed tests; do not bypass these guards.

Only the dedicated read-only caller authorization profile uses a 10-second total
query deadline, plus its existing 5-second acquisition limit. Expiry waits for
the SDK completion callback after abort; it does not race and abandon work.
Server statement and queue timeouts are also set to 10 seconds. Client abort
cannot guarantee instant remote cancellation; these server limits bound a query
that already reached Snowflake. Do not apply this mechanism to mutations with
unknown outcomes or to legitimate long-running batch work.

Failed connections are destroyed, never released for reuse. Logout has a separate
2-second bound; the SDK closes its per-connection agents even if logout fails.
An idempotent destroy wrapper preserves the SDK callback signature and prevents
a second network logout when generic-pool removes the connection. Pool replacement
runs outside the expired context. Remote session deletion remains best effort.
Authorization expiry returns 503 with Retry-After and never caches privileges.
Thus the designed budget is up to 5 seconds acquisition + 10 seconds query +
2 seconds cleanup, subject to event-loop scheduling; not a 10-second whole-HTTP
request SLA. Ordinary upload/storage/batch queries are unchanged.

Tests use the real SDK and loopback sockets for headers, result polling, backoff,
concurrent isolation, successful reuse, failed logout, and pool replacement. The
isolated-only probe in `scripts/load-test/query-deadline-probe.ts` exercises the
same helpers inside a cloud build; it is not a production route.

The role pool also has `acquireTimeoutMillis: 5000`. This removes abandoned
borrowers from generic-pool's queue instead of allowing connection factory retries
to continue indefinitely after the application's acquisition timer has expired.
An actual-SDK login-outage test verifies the queue empties and no new connection
attempt starts after the in-flight attempt ends.

The connection factory also preserves only numeric SDK error code and HTTP status
when wrapping login errors. It deliberately excludes the HTTP response and cause,
which can carry credentials. Role-connection acquisition retries a confirmed
401002 / HTTP 503 login failure once after 100 ms, within its existing two-attempt
budget. Authentication denials are not retried, and no SQL is replayed. Real-SDK
loopback tests cover recovery and persistent 503 exhaustion.

Role acquisition has one five-second total budget, including cleanup grace and
any retry delay. The first attempt receives four seconds; a retry uses only the
remaining budget. This avoids cancelling a healthy three-second cold login while
still bounding stalled transports and never retrying authentication denials.
