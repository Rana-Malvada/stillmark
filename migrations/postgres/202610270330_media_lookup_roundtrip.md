# media lookup roundtrip

Adds a SECURITY INVOKER media lookup callable only by the app role. Existing RLS and album ACLs apply. Compatible with the old app; disabled unless PG_MEDIA_LOOKUP_FUNCTION_ENABLED=true. Statement-local identity resets on completion.

Apply through the checked migration runner after backup verification.

Verification:

```sql
SELECT prosecdef FROM pg_proc WHERE oid='photo_security.lookup_media(text,jsonb)'::regprocedure;
```

Rollback: Disable PG_MEDIA_LOOKUP_FUNCTION_ENABLED before dropping photo_security.lookup_media(text,jsonb).
