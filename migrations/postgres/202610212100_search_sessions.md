# Saved search sessions

Additive tables and statement-level invalidation triggers. Old runtime remains compatible.
Search text and documents are private to the authenticated search owner, enforced by
forced RLS. Maintenance can process batches. Cached IDs are never authorization;
all pages hydrate through current photo/event RLS. Catalog and face/share changes
invalidate old sessions. Retain at most 50 sessions per user for 14 days.

Verify own-user isolation, invalidation and stale publication fencing with the
PGlite integration tests before applying through the checked migration runner.
New runtime requires this migration. Rollback may leave tables/triggers intact.
