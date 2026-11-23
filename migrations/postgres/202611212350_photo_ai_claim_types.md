# Photo AI claim result types

Production `photos.display_stage_path` is `varchar(1024)` and `file_hash` is
`varchar(64)`. The existing claim function declares both results as `text`.
PostgreSQL rejects its `RETURN QUERY UPDATE` with SQLSTATE 42804 when a photo is
eligible, rolling back the claim and leaving automatic descriptions idle.

This forward migration explicitly casts those two returned values to `text`.
It preserves the function signature, SECURITY INVOKER execution, search path,
ownership, grants, fair ordering, limits, leases and quotas. No rows or table types
are changed. Both the current and next application versions are compatible.
Keep this migration installed if application code is rolled back.

Verification: the admission unit and native PostgreSQL tests use the production
varchar types. Six claim tests failed with 42804 before this fix. After migration,
validate eight concurrent claims, tenant fairness, quotas, disconnect recovery,
stale-token fencing and denied application-role execution. The native test checks
that the returned paths and hashes are unchanged. Apply through the normal
backup/restore and migration runner. Observe a real newly uploaded photo moving
from zero attempts to a saved description without a manual restart.

Read-only installation check:

```sql
SELECT pg_get_functiondef('public.claim_photo_ai(uuid,int,int,int,int)'::regprocedure);
```
