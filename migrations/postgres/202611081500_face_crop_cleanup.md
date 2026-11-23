# Durable cleanup for face crop publication

## Reason

The scanner used to unlink newly written crop files on every publication error.
A lost PostgreSQL response after a successful commit could therefore remove files
that committed face rows referenced. The queue row was already complete, so the
ordinary retry path would not repair those crops.

## Change and privileges

The additive `face_worker.reserve_crops(integer, uuid, text[])` function registers
cleanup before the scanner writes files. It accepts at most 5,000 UUID-named
`faces/*.webp` paths, requires the matching live photo claim, and uses the existing
storage-path publication fence. Its fixed search path and explicit worker-only
EXECUTE grant constrain the SECURITY DEFINER boundary; no new table grants or
runtime identities are added. Application users cannot call it.

Cleanup is initially delayed 24 hours, beyond the worker's two-hour maximum run.
The existing cleanup function retains live face references and retires orphaned
paths so delayed publication cannot race a deletion. Repeating a reservation is
idempotent and does not postpone an existing cleanup deadline. Publication errors
leave cleanup to that durable process, including errors whose commit outcome is
unknown.

## Rollout and rollback

Apply this migration before deploying a new immutable face-worker image containing
the updated `worker.py`. An app-only deployment does not update the face image.
Older worker images remain compatible with the added function. The new worker
fails before writing crops if the migration is missing or a reservation is denied.

Do not roll back to the old immediate-unlink error handler. To pause rollout,
stop starting new face scans and retain the additive function and outstanding
cleanup rows. The migration changes no existing faces, crops, or queue states.

## Validation

Run `python3 -m unittest discover -s workers/face-cpu -p test_publication.py` for
the actual publication handler without native-model dependencies. It covers
reservation failure, failures before SQL execution, stale publication, a lost
commit acknowledgment, successful publication, and empty results.

Run `npx vitest run tests/face-crop-cleanup.test.ts` for the real migration SQL,
worker-only grants, claim and path bounds, repeated reservations, live-reference
preservation, orphan reclamation, and retired-path fencing. The existing native
PostgreSQL cleanup race check remains applicable to the shared storage fence.
