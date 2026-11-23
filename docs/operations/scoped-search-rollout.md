# Scoped search revision rollout

The expansion migration installs album/user counters, saved-search scope columns and statement triggers. Legacy invalidation remains until all consumers are upgraded. The app, replay, batch status and search worker use the same scope fingerprint. It covers all requested albums, the viewer and the emergency generation; it is never an authorization credential. Hydration still applies RLS.

## Release order

1. Complete the normal backup/restore verification and expansion migrations.
2. Drain old search jobs. Build/publish the updated search CPU image and update its generated specification with the normal build tooling. Upgrade the app. Verify both consumers use `scope_revision`.
3. Run `scripts/release/sql/activate-scoped-search.sql` **after** those checks. It atomically removes the legacy content triggers and bumps the emergency generation. Never run it as a pre-deploy migration.
4. Verify unrelated album edits preserve searches, participating album edits invalidate searches, shared-name edits propagate, and revoked access is denied. Check batch status and a finite ranking job.

Activation is a separate live-state change, not implied by source deployment.
Inspect the installed triggers and release evidence before applying either script.
When legacy triggers remain, global invalidation is intentional for compatibility.

Before reverting to an old app/search-worker version, run `scripts/release/sql/rollback-scoped-search.sql`. It restores legacy triggers and invalidates old caches. Keep the additive columns/tables during rollback.

## Invalidation and security

Photo, event and share changes bump album counters. Face/assignment changes bump their photo's album. Person/settings changes bump the owner's albums, albums containing their face records, and the user's counter. User/admin changes bump that user's counter. Changed scopes are incremented once per statement in sorted order. Deleted-album counters remain as tombstones. Explicit housekeeping fields are excluded; unknown new fields invalidate conservatively.

RLS restricts counter reads to the current user and accessible albums. Trusted maintenance/search workers can evaluate their saved work. Local PostgreSQL-engine tests cover bulk changes, unrelated scopes, housekeeping, private counters and revocation. They do not establish production lock latency or concurrency capacity.
