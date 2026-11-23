# Indexed parent-album authorization

Changes the scoped reader's photo policy from a readable-album set to an indexed
parent-album existence check. The existing events policy still decides ownership,
gallery visibility and explicit sharing. No permissions or roles are broadened.

Apply only after setup 71. The migration takes a brief policy DDL lock, bounded to
five seconds; retry later if busy. Validate tenant isolation and album-page query
plans. Roll back with:

```sql
ALTER POLICY catalog_reader ON public.photos TO personal_photos_reader
USING (event_id IN (SELECT event_id FROM public.events));
```

Validate in the isolated load-test database before production rollout; retain the
release-specific outcome in private evidence.
