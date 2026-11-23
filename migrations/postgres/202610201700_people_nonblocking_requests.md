# Nonblocking face rematch requests

Confirmed assignments and named/unhidden groups now append to an owner-scoped
request inbox instead of updating the worker's locked progress row. The worker
drains at most 1,000 requests per batch and coalesces owner/model pairs into the
existing queue. Inserts arriving during a batch remain for the next batch; a
failed transaction restores drained requests. Existing thresholds and queued
work are retained. Assignment and candidate row locks remain to preserve manual
corrections, so this removes queue contention, not all possible locking.

Compatible with the current deployed app: the maintenance function signature
and correction APIs are unchanged. No face labels or media are changed by the
migration. New requests participate in the same transaction as the correction.
RLS scopes app reads/inserts to the correcting owner; only maintenance drains.
The existing backup covers the public schema and the new identity sequence.

Validate with tests/people-rematching.test.ts, including owner isolation,
rollback, bounded processing and restarting after a new confirmed reference.
Inspect queue progress and pending requests with read-only queries:

```sql
SELECT count(*) FROM public.face_match_requests;
SELECT after_face_id,requested_at FROM public.face_match_queue;
```

Do not roll back to the old shared-row trigger under load. The inbox can safely
remain across app version rollback because it is consumed by the DB function.
