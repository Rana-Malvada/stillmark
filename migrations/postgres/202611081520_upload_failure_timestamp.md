# Durable upload failure monitoring

## Compatibility

Apply before the updated web app and upload worker. The additive `failed_at` column
and trigger support existing workers without changing their writes. Existing
terminal failures use `updated_at` as the best available historical timestamp.
New failures use database time; metadata updates cannot move the failure window.
Retrying a job clears the timestamp, and a later terminal failure starts a new window.
Deletion-request cancellation removes unfinished sessions/jobs and does not create
an operational failure. No runtime grant or credential changes are required.

## Verification

Run the monitor and upload-queue-metrics tests. The monitor test executes the real
migration and route SQL against a local database with three terminal queue failures
and no legacy failure rows, then passes the response through the gateway monitor.
It also covers retries, stable timestamps, the one-hour window, and recovery.
No production migration has been applied as part of this change.

## Rollback

The previous runtime can run with this additive migration. Leave the column,
trigger, and index in place when rolling back the application; do not edit an
applied migration. Removing them requires a separate reviewed forward migration
after no runtime reads `failed_at`.
