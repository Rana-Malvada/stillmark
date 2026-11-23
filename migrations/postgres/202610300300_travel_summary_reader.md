# Travel map reader permissions

Corrects the permission-denied regression introduced when summary reads were enabled. Map transactions explicitly switch to `personal_photos_reader`; the original summary migration granted only the runtime role access.

Adds SELECT and reader-specific policies to the three derived summary tables. Policies inherit current album RLS, including identity, ownership, shared visibility and revocation. No write, builder, source-data or public privileges are granted. Existing runtime and worker policies remain unchanged.

The corrected map integration tests use the actual reader role and catalog RLS setup, compare cold/warm summaries to raw queries, and verify revoked and absent identities cannot read summaries or run the builder. Apply transactionally through the migration runner. The runner performs its required backup/restore check before application. Application rebuild is unnecessary. Roll back by disabling summary reads before revoking these grants/policies; do not alter source media.
