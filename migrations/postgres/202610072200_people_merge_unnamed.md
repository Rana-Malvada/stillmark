# People: merge unnamed groups

Lets the face worker combine unnamed groups it created when they are the same person.
Additive: two `face_worker` functions, `DELETE` on `face_people` for the worker
(guarded), and one trigger.

## Why

Age, lighting, and angle can split one person into separate unnamed groups.
Comparing each face with its closest faces in the other group handles this
variation without relying only on a whole-group average. Threshold selection
requires owner-labelled validation; preserve the configured conservative threshold
and all curation exclusions. Store evaluation results outside the repository.

## Objects

- `face_worker.unnamed_groups(owner, model)`: faces of unnamed, visible groups that have
  no confirmed face. Only these are mergeable.
- `face_worker.merge_unnamed(owner, keep, absorb[])`: moves assignments into `keep`,
  deletes the emptied groups and refreshes the cover. Skips any group that is named,
  hidden, has a confirmed face, belongs to another owner, or contains a face the owner
  rejected for `keep`. Self-merges and oversized requests are rejected.
- `photo_security.guard_person_delete`: the worker may delete a person only when it is
  unnamed and has no assignments. Other roles are unaffected.

All functions are `SECURITY INVOKER`; `EXECUTE` is granted only to the face worker.

## Compatibility

Additive. Older worker images do not call these functions.

## Verification

`npx vitest run tests/people-worker.test.ts` (merging unnamed groups) covers moves and
cover selection, named and curated groups untouched, rejection respect, owner isolation,
malformed requests, the delete guard, and eligibility listing. After apply:

```sql
SELECT proname, prosecdef FROM pg_proc WHERE pronamespace='face_worker'::regnamespace
  AND proname IN ('unnamed_groups','merge_unnamed');
SELECT has_table_privilege('personal_photos_face_worker','face_people','DELETE');
```

## Recovery

Revoke `EXECUTE` and `DELETE` from the worker in a forward migration. Merges are
visible in the People UI and can be split by the owner.
