# Preserve People covers during automatic merges

Replaces `face_worker.merge_unnamed` so the surviving unnamed group retains its
existing cover when new faces are merged into it. A replacement is selected only
when the cover is missing, ignored, no longer assigned, or has no crop.

## Compatibility

Same function signature and permissions; compatible with the existing worker.
No data rewrite. Apply this migration through the normal release migration process
before relying on stable covers during scans. Existing migrations are unchanged.

## Verification

Run `npx vitest run tests/people-worker.test.ts tests/people-corrections.test.ts`.
Coverage includes preserving covers after higher-quality faces arrive, choosing a
cover when missing, and retaining a manually selected suggested face after tagging.

## Recovery

Forward-fix the function in a new migration. No photo or face data is deleted by
this change beyond the existing removal of empty groups after a merge.
