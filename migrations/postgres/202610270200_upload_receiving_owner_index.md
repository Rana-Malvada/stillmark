# upload receiving owner index

Adds a partial index for unfinished upload sessions; no row, grant or policy changes.

Apply through the checked migration runner after backup verification.

Verification:

```sql
SELECT indexdef FROM pg_indexes WHERE indexname='upload_sessions_receiving_owner';
```

Rollback: DROP INDEX public.upload_sessions_receiving_owner;
