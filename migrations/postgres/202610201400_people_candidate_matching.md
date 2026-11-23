# Recognize faces independently of reference quality

Previously, `face_worker.match` excluded every detection with `quality_ok=false`,
even when its embedding clearly matched a known person. Those detections can now
match against named people with confirmed, good-quality references.

Lower-quality candidates require an average top-three similarity of at least
0.75, three reference faces, and a 0.12 margin over the runner-up for automatic
assignment. Scores of at least 0.60 otherwise become review suggestions. Configured
thresholds remain a floor. These conservative thresholds need monitoring against
real review outcomes; similarity scores are not probabilities.

## Compatibility

Same function signature and permissions, compatible with the existing worker.
The migration changes no existing assignments. After deployment, run the normal
organization step to match existing unassigned detections using stored embeddings.
No photo rescan is needed. Ignored faces, existing assignments, rejected identities,
and hidden people remain excluded. Reference quality and unknown-group eligibility
are unchanged; lower-quality matches cannot become reference examples.

## Verification

Run `npx vitest run tests/people-worker.test.ts tests/people-corrections.test.ts`.
Tests cover strong recognition, weaker suggestions, insufficient references,
ignored/rejected faces, reference exclusion, and existing matching behavior.

## Recovery

Forward-fix the function in a new migration. Reverting the function alone does not
undo assignments made by subsequent organization runs; use normal correction tools
to review those assignments. No photos, detections, or correction history are deleted.
