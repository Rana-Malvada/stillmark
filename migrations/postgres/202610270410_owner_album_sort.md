# owner album sort

Adds an owner/sort/id index for album pagination. Existing app is compatible; no permissions or data change. Transactional creation is bounded by a five-second lock timeout.

Apply through the checked migration runner after backup verification.

Verification:

```sql
SELECT indexdef FROM pg_indexes WHERE indexname='events_owner_page_sort_idx';
```

Rollback: DROP INDEX public.events_owner_page_sort_idx;
