# Cancel search work for never-published deleted photos

The old deletion trigger unconditionally created removal work. This migration
tracks whether a queue item has been claimed by the publisher. Deletion cancels
unclaimed work when the photo has no acknowledged search copy. Claims commit
before reading photos or submitting Snowflake writes; the deletion upsert locks
the same queue row. A claim that wins first therefore retains removal work even
when publication succeeds without an acknowledgment. A deletion that wins first
prevents the publisher from claiming or reading that photo.

Published history is preserved across queue edits and restore/redelete. Existing
queue rows are conservatively marked attempted because the old publisher did not
record claims. Historical removals must finish their normal remote deletion and
acknowledgment; a missing timestamp alone does not prove they were never submitted.
No historical tombstones are blindly cleared. Event indexing is unchanged.

## Release order

Drain and stop all search publishers, including manual sync calls, before applying
this migration. Verify backups and apply with the release migration runner. Deploy
the updated publisher before resuming sync. Do not allow old publishers to overlap:
they do not claim their work. Other writers should be drained during the short
schema lock, as for the gallery-statistics migration. This change has not been
applied to production as part of its implementation.

## Validation

Run `npm run typecheck` and `npm test`. The search-delete-cleanup tests execute the
actual migrations, claim SQL, acknowledgment SQL, and statistics triggers. They
cover untouched ready/unfinished photos, both claim/delete orderings, unsuccessful
publication, stale acknowledgment, mixed bulk deletion, legacy history, and
restore/redelete. `node scripts/verification/search-delete-cleanup.mjs` runs 30
real PostgreSQL lock-contention races in a disposable loopback-only Postgres 17
container. It observes blocking through `pg_blocking_pids`, tests both lock
orderings and publisher rollback, rejects stale acknowledgment, and reconciles
removal counters. This is also a required release database gate. Full repair marks
records discovered in the remote search table as already attempted before claims.

Hold the existing `search-sync` PostgreSQL advisory lock in a dedicated session
from before migration until the new runtime is verified. Acquiring it waits for
an existing publisher to finish; new manual publishers skip while it is held.
Maintain and verify that session throughout release, and release it only after
old runtime replicas are gone. No global application suspension is needed.

## Rollback

Stop publishers first. Before restoring an old publisher, use a new forward
migration to restore the previous `queue_photo_search_statement` function from
`202610311200_gallery_statistics.sql`, set the new column default to true, and mark
all queue rows attempted. Leave the additive column in place. This restores
unconditional removal behavior. Never run an old publisher with the cancellation
trigger active, and never edit an applied migration.
