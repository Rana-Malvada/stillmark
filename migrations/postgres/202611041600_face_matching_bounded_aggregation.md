# Face matching: bounded aggregation

## Compatibility

Replaces only `face_worker.match_candidates`. The signature, invoker permissions,
100-face maintenance batch, timeout, queue cursor and transaction boundary remain
unchanged. There are no data changes or new grants. Existing workers can use the
replacement without a restart.

The previous query combined every candidate with all eligible references before
grouping and sorting. PostgreSQL also inlined candidate eligibility expressions
into that join. The replacement evaluates candidates and references once, then
uses a correlated aggregate to reduce each candidate's reference scores before
combining candidate results. Intermediate aggregation scales with references for
one candidate rather than batch size multiplied by reference count. Exact vector
comparison still requires work proportional to eligible references; this does
not introduce approximate matching or claim constant-time matching.

Same-photo exclusion, distinct-photo consensus, top-three reference averaging,
ambiguity thresholds, ignored/hidden faces, rejections, owner isolation and
confirmed-assignment protections are preserved.

## Verification

On November 4, read-only scoring probes against the queued owner's next 100 faces:

- Original query exceeded a 10-second statement limit.
- Replacement: 2.170 and 2.190 seconds; forced generic prepared plan: 2.966 seconds.
- Replacement sorts 11,013 reference-photo scores per candidate instead of
  1,101,300 together. Its per-candidate hash aggregate used 1,305 KiB and sort
  used 901 KiB in this sample. These are individual plan-node measurements,
  not total connection memory.

These are scoring probes, not full worker completion or load-test measurements.
All probes rolled back and did not change assignments. Local PostgreSQL tests
compare the old/new functions' assignments and scores for a full 100-face batch
and exercise the existing security and matching-rule cases.

After migration, inspect the existing queue cursor and maintenance logs to verify
that real transactions commit and SQLSTATE 57014 no longer repeats for this job.
Do not mark completion based only on the read-only probe.

## Rollback

Restore just the previous `match_candidates` function definition from
`202610211200_people_rematch_unnamed.sql` in a new reviewed migration. Do not
replay that entire historical migration, which also queues work. Rollback restores
the expensive query; fixing forward is preferred. No data rollback is required.
