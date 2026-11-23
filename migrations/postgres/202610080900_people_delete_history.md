# People: owners can delete their correction history

Adds `DELETE` on `face_corrections` for the app role, limited by row security to the
caller's own rows when they have write access (`photo_security.edits_people`).

## Problem

"Delete face data" in People settings removes faces, people, matches and queued
scans. Correction history (`face_corrections.before_state`) holds snapshots that
include names, and the app could not delete it.

## Change

- `GRANT DELETE ON public.face_corrections TO personal_photos_app`
- Policy `app_delete`: `USING(photo_security.edits_people(owner_username))`

## Compatibility

Additive. No existing grant, policy, column or function changes. The deployed app
does not delete correction rows until the People release that calls it.

## Verification

`npx vitest run tests/people-corrections.test.ts` covers owner deletion and that
another user's history is untouched. After apply:

```sql
SELECT has_table_privilege('personal_photos_app','public.face_corrections','DELETE');
SELECT count(*) FROM pg_policies WHERE tablename='face_corrections' AND policyname='app_delete';
```

## Recovery

Forward-fix only. To withdraw: `DROP POLICY app_delete ON public.face_corrections;
REVOKE DELETE ON public.face_corrections FROM personal_photos_app;` in a new migration.
