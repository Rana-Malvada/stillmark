# role cache nonblocking cleanup

Replaces only the shared-cache writer cleanup with FOR UPDATE SKIP LOCKED. Preserves function privileges, signed envelopes, exact-context keys and 60-second expiry. Compatible with both app versions.

Apply through the checked migration runner after backup verification.

Verification:

```sql
SELECT pg_get_functiondef('photo_security.write_role_cache(text,text,bigint)'::regprocedure);
```

Rollback: Restore the writer definition from migration 202610260140_shared_role_cache.sql; retain the table and its data.
