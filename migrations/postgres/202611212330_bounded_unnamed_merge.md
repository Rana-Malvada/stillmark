# Resumable unnamed-face merges

Creates worker-only generation and checkpoint tables and bounded page functions.
The worker scans all eligible pairs before committing the highest score, then
restarts the pass after each merge. A merge absorbs one group, below the existing
500-group SQL limit. Full groups are scored; neither faces nor groups are sliced
to the legacy 5,000-face clustering limit.

Statement-level change triggers invalidate saved scores for affected owners.
Named, hidden, confirmed, ignored and rejected evidence is preserved. A group
that is a rejection target is considered curated and is not auto-merged: deleting
it would cascade-delete a user's rejection evidence.

Validation: `workers/face-cpu/test_bounded_merge.py` covers exact block scores,
5,002 faces, 503 groups, deadline/restart continuation, generation invalidation
and global best-pair ordering. `scripts/verification/bounded-face-merge.mjs`
exercises the functions, change triggers and role restrictions in disposable
PostgreSQL, using synthetic vectors and people only.

Deploy this migration before the worker image. Rollback the worker image first;
the old worker ignores these additive functions/tables. Drop the twelve
`merge_invalidate_*` triggers before removing `face_worker.invalidate_merge` and
the merge progress/generation tables. No media, named people or assignments are
removed by the migration itself.
