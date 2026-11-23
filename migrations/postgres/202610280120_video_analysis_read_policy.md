# Indexed video-analysis visibility checks

Preserves the existing rule: a video-analysis row is readable when its referenced photo is visible through the photo table's RLS, or the corresponding trash item is visible through trash RLS. Both parent checks now constrain the primary key to the requested photo. `OFFSET 0` prevents flattening into a whole-catalog hash/scan plan.

This affects the photo search-vector trigger as well as video-analysis reads.
No data, permissions, batch scheduling, role grants, database size or warehouse
settings change. Compare query plans and timings on the same catalog snapshot.

Apply transactionally with a bounded lock timeout. Verify owner, shared, gallery, revoked-sharing, trash and unauthorized access. Existing write policies are unchanged. Rollback can restore the original policy expression from setup/72-app-rls.sql, but restores the expensive catalog plan.
