# Rematch when a confirmed group receives a name

A group can already contain confirmed assignments before receiving a name. Naming
it does not change those assignment statuses, so the assignment trigger alone
cannot enqueue recognition. This additional invoker trigger queues the owner's
models when an unnamed group is named or a named hidden person is restored.
Ordinary name edits and hiding do not enqueue work. Owner RLS remains enforced.

## Compatibility and verification

Additive database-only follow-up to the confirmed-reference migration. Compatible
with both app versions; no assignment rewrite, new app API or worker image needed.
Apply through the migration runner and its backup restore check. Run
`npx vitest run tests/people-rematching.test.ts` for naming and unhide queue coverage.
Inspect `face_match_queue` after naming a group with confirmed detections. The
background consumer drains it in bounded batches.

## Recovery

Forward-fix the trigger in a new migration. Queue work is retryable and existing
labels are not changed by enqueueing a request.
