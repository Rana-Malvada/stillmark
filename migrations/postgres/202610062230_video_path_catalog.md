# Indexed rendition projection with live row security

The JSON containment index cannot be pushed through the current row-security
barrier. Replace it with an indexed, normalized projection of rendition paths.
A trigger keeps the projection synchronized for every writer, including the GPU
worker, old app versions and maintenance. Playback deletion cascades. Ready status
and original-path matching are still checked against the live playback/photo rows.
No media is regenerated or copied.

The app can only SELECT the projection. Its RLS checks `visible_photo`, a fixed
search-path SECURITY INVOKER function that selects a single photo under the caller's
existing photo policies. The playback SELECT policy uses the same exact-ID check,
replacing an equivalent whole-photo membership subquery. Write policies stay intact.
The projection trigger is SECURITY DEFINER, has a fixed search path, only writes
paths derived from its authorized source row, and cannot be called as a normal SQL
function. It grants no direct write access to the application or GPU worker.

The migration runner now tokenizes SQL quoting/comments before rejecting top-level
transaction escapes. This permits reviewed trigger bodies containing BEGIN/END;
actual transaction-control statements, psql commands, concurrent indexes and vacuum
remain forbidden and tested. Database function bodies cannot commit the surrounding
migration transaction.

Apply with backup restore verification and bounded locks. Test real app-role
EXPLAIN plans and RLS tests for private/shared/revoked/stale/changed rendition paths,
plus projection insert, update and cascade deletion. Old application versions remain
compatible. Roll back code without removing the projection or altering migration hashes.
