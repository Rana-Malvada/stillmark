# Transactional gallery statistics

Install through the migration runner in a single transaction, with writers drained.
This migration locks events, photos and search_queue while constructing the baseline.
It aborts after a five-second lock wait or a two-minute statement timeout; do not
retry continuously against active uploads. Production installation requires an
explicit release request and the checked migration workflow.

The reader is opt-in with `GALLERY_STATISTICS_ENABLED=true`. Leave it absent until
migration reconciliation and write-contention checks pass in the release environment.
The migration itself changes writer triggers even when that reader flag is off.

## Contract

Ready photos/videos contribute to per-album counters and 32 global buckets. The
main administrator reads the global buckets; restricted administrators read album
counters through current RLS. This removes photo/queue scans from Stats, without a
TTL cache. Restricted reads still scale with authorized album count.

AI description presence, pending work and terminal failures partition ready photos.
A claimed third attempt stays pending until its claim is cleared; lease expiration
alone does not change committed counters. Search counts mean acknowledged copies,
not confirmation that Cortex indexing has finished. New/restored photos lose stale
acknowledgment timestamps. Existing timestamps retain their historical meaning.

Queue entries retain album scope and explicit upsert/removal classification across
deletion. Historical tombstones whose scope cannot be recovered are main-admin-only.
Counters and source changes commit or roll back together. Statement triggers group
bulk changes; fixed bucket ordering reduces contention but does not prove absence
of deadlocks across transactions with multiple statements. Callers must retry entire
transactions after a database deadlock, never only the last statement.

## Validation and recovery

Run `npm run test:gallery-statistics-postgres` against disposable local PostgreSQL,
plus `tests/gallery-statistics.test.ts` for the application RLS fixture. The local
script reconciles every counter with source contributions after lifecycle changes,
rollback, deletion, stale acknowledgments and concurrent writers. It inspects the
read plan and repeats measurements after inserting 10,000 synthetic photos.

Before enablement, compare end-to-end writer throughput with the previous schema under
the same workload, exercise acknowledgment/edit contention, and reconcile using
production-shaped data in isolation. Local sub-millisecond reads are not a live
latency or billion-row capacity guarantee. Activity's time-dependent job summaries
remain separate queries; this migration does not eliminate every Activity scan.

For a reader rollback, unset the flag; this restores the old read path, not the old
writer triggers. Never drop counters or disable triggers while writes continue.
For a writer rollback or reconciliation repair, drain writers, take a verified
backup, and apply a reviewed transactional forward migration restoring the previous
queue triggers or rebuilding the baseline under the same locks. TRUNCATE is rejected
on source tables to prevent silent drift. Do not grant counter-write access to the
application role or bypass triggers during normal imports/restores.

## Optimized writer implementation

Counter triggers use separate static, typed functions for each source/event so
PostgreSQL can cache plans. Empty transitions and unchanged counter inputs return
early. Each function groups signed deltas and applies one ordered UPSERT; it does
not issue an UPDATE per counter or perform a repeated lookup into a materialized
delta set. An AFTER trigger rejects negative final values, including a missing
baseline. This validates the actual UPSERT result rather than rejecting a valid
negative input delta before ON CONFLICT executes. Counter writes remain denied to
the application role.

The local A/B now holds each schema configuration steady, warms plans and rolls
back sample rows through savepoints. DDL invalidation is outside measured samples.
`npm run test:gallery-statistics-writes` separately compares the original schema
fixture (including its real search triggers/indexes) with the migrated schema.
Neither fixture measures complete upload throughput, network/storage time or the
current production schema. A five-percent end-to-end write-throughput gate cannot
be inferred from percentages on a sub-millisecond isolated INSERT.
