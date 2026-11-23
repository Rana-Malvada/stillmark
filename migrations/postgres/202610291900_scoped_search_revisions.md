# Scoped search revision expansion

Compatibility: additive tables, columns, RLS policies, fingerprint function and statement triggers. Existing global triggers remain active. Apply before the new app/search CPU worker; activation is a separate post-upgrade operation. No populated catalog backfill is necessary: missing scope counters start at zero and old sessions have no matching scope fingerprint.

Verification: `tests/people-search.test.ts` exercises the migration with runtime RLS roles, bulk edits, unrelated libraries, shared access and revocation. Follow `docs/operations/scoped-search-rollout.md` for deployed checks. Build/publish the updated CPU worker before removing legacy triggers. Test worker claim and publication with the new fingerprint.

Rollback: preserve the additive schema. Before restoring old consumers after activation, run `scripts/release/sql/rollback-scoped-search.sql`; it restores the legacy invalidation triggers and bumps the emergency generation. Never remove the global compatibility triggers during expansion. Run the standard backup/restore gate before application.
