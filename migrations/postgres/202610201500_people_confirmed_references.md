# Learn from confirmed identities and rematch existing detections

Confirmed, named faces with stored embeddings become references regardless of the
`quality_ok` detector flag. Automatic matches never become named references.
Matching takes the best example per reference photo, averages the top three photos,
and excludes the candidate's own photo. Named automatic assignments require three
reference photos, score >= 0.75 and a runner-up margin >= 0.12. Other matches >= 0.60
become suggestions. Configured worker thresholds remain a floor. Unknown group
creation keeps its existing quality gate.

Confirmations insert a durable, owner/model-scoped queue request in the same
transaction. The application's existing maintenance runtime processes 100 faces
every 10 seconds. Each transaction locks a queue row and candidate faces; retries
retain the cursor, and later confirmations restart the pass. Queue requests use
invoker privileges and owner RLS; only maintenance can execute the batch processor.
Ignored faces, rejected identities, hidden people and existing labels are preserved.
Disabled People owners are not processed. Review results are ordered by person for
existing bulk confirmation controls.

## Compatibility and rollout

Apply after `202610201400_people_candidate_matching.sql` using the migration runner.
The scan worker's signature is unchanged; it matches at most 100 candidates per
call and queues the rest with its configured thresholds. Run matched counts reflect
the immediate batch, with later matches added by background maintenance. Older apps can still confirm faces; their
requests accumulate until an app with the maintenance consumer is running. The
backup utility includes `face_worker` because the new public trigger depends on it.
No embeddings, assignments or photos are rewritten by this migration.

Run the read-only audit with a Python environment containing NumPy:
`python scripts/people/evaluate-matching.py --owner USERNAME`.
It holds out entire photos and reports aggregate results without exporting vectors.
Its reference set is named confirmed faces only; normal scans also retain
unnamed-group matching. Keep aggregate evaluation results in private evidence.

For an authorized existing backlog, insert distinct owner/model pairs from detected
faces into `face_match_queue` with `ON CONFLICT ... DO UPDATE SET after_face_id=0`.
Do not rescan or delete detections. Inspect queue progress with
`SELECT owner_username,model_version,after_face_id FROM face_match_queue`.

## Verification

Run `npx vitest run tests/people-rematching.test.ts tests/people-worker.test.ts tests/people-corrections.test.ts`.
Tests cover low-quality references, independent-photo consensus, ambiguity,
owner isolation, transaction rollback, ignores/rejections, disabled People,
existing labels, no automatic-reference feedback and bounded resumable processing.
Run the normal full release checks and backup restore drill before deployment.

## Recovery

Stop the rematching consumer and forward-fix in a new migration. Queue requests
can safely be retried. Reverting a function does not undo previous matches; use
normal correction controls for those labels. Never delete confirmed labels to
rerun recognition. No automatic matches are promoted to confirmed by this change.
