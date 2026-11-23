# Indexed parent authorization for application photo reads

The application photo SELECT policy previously materialized every readable album
for the caller, even for a single media lookup. Replace that list with a primary-key
lookup of the photo's parent event under the existing event RLS policy. OFFSET 0
preserves the correlated lookup. No grants, ownership rules or SECURITY DEFINER
functions change. The restrictive selected-photo public-link policy and all photo
write policies remain unchanged.

Apply after application RLS (setup 72). The transaction uses a five-second lock
timeout; retry later if a load is active. Rollback:

```sql
ALTER POLICY app_read ON public.photos TO personal_photos_app
USING (event_id IN (SELECT photo_security.readable_events()));
```

Validate query plans and mixed browsing/upload workloads in isolation before
rollout. Security tests must cover anonymous denial, own, shared and gallery
visibility, public-link revocation, read-only access and writes. Store results in
private release evidence.
