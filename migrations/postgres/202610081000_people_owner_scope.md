# People: face data follows the photo's current owner

Fixes a review finding: after a photo moved into another owner's private album, its
former owner lost access to the photo but could still read its face crop, matches and
names, and still found it when searching for a person.

## Change

- `photo_security.current_face(face_id)`: true while the face's owner still owns the
  photo (photo → album → owner).
- `faces` and `face_assignments` app policies require `current_face` for owners;
  `shared_face` (name sharing) requires it too.
- Trigger `retire_moved_faces` on `photos.event_id` and `events.owner_username`
  changes: deletes the former owner's faces for the photo (assignments and rejections
  cascade), queues their crops in `stage_cleanup`, and queues the photo for the new
  owner when they have People on.
- One-time cleanup of photos that already moved.

## Compatibility

Policies are replaced in one transaction; same names, narrower access. The deployed
app needs no change. Correction history keeps snapshots; undo of a correction whose
faces were retired skips the missing faces, as before.

## Verification

`npx vitest run tests/people-ownership.test.ts` (move to another owner's album, album
owner change, sharing, search, crop route). After apply:

```sql
SELECT count(*) FROM pg_trigger WHERE tgname='retire_moved_faces';  -- 2
SELECT count(*) FROM faces f WHERE f.owner_username IS DISTINCT FROM photo_security.photo_owner(f.photo_id);  -- 0
```

## Recovery

Forward-fix only. Retired faces are rebuilt by scanning for the new owner.
