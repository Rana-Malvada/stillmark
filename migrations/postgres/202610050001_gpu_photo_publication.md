# GPU duration publication policy

## Compatibility

Adds `gpu_publish_duration`, an UPDATE row-level policy on `public.photos` for
`personal_photos_video_worker`, restricted to video rows. Existing column grants
remain unchanged: the worker already has UPDATE on duration. The policy permits
the existing publication path's SELECT FOR UPDATE without allowing original edits.

## Verification

Inspect `pg_policies` for the policy and verify the worker's column grants. Run the
database access-boundary tests; verify unrelated photo fields remain unwritable.
Perform an authorized worker publication test when changing this boundary further.

## Recovery

Dropping this policy can stop duration publication and row locking for active workers.
Wait for worker activity to finish before a separately reviewed forward migration.
An application rollback does not undo this policy. Preserve this applied SQL file.
