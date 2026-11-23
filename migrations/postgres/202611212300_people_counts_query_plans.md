# Separate People count query plans

The existing optional `selected_person IS NULL OR ...` predicate made PostgreSQL
use one generic plan for two different workloads. On a representative synthetic
inventory this repeatedly looked up photos when counting an entire owner's faces.
The replacement uses two static branches: a complete owner inventory and a single
person lookup. Output columns, distinct photo counts, review counts, ordering at
the caller, current album ownership joins and identity restrictions are unchanged.
No index, cache, row policy or application pagination changes are needed.

`CREATE OR REPLACE` preserves the existing function owner and execution ACL. The
function remains `STABLE SECURITY DEFINER` with a fixed search path. Its joins
still reject stale faces and assignments whose owners differ from the photo's
current album or person. Shared viewers and administrators do not gain another
owner's face counts.

Apply after `202611142300_people_counts.sql`, before or after the compatible app
release. To roll back, replace only `person_counts(uuid)` with the original SQL
body from that migration using `CREATE OR REPLACE FUNCTION`; do not recreate or
change `people_totals()` or its grants.

## Validation

Run `STILLMARK_TEST_PG_TMPFS_MB=256 node scripts/verification/people-counts-query-plans.mjs`
for a disposable native PostgreSQL test, or omit the optional tmpfs setting when
local Docker storage has space. It compares every owner count, selected-person
counts, the ordered first page including duplicate names, and execution grants
before and after the migration. It includes ignored/suggested faces, mismatched
ownership, a shared viewer, no identity, and the non-admin app role. The existing
`tests/people-rls.test.ts` also applies this migration and verifies real row policies.

Record query plans, buffer usage, complete result equality, and ordered-page
equality in private release evidence. Database measurements do not establish
production browser latency or concurrent-user capacity. Upload and thumbnail
paths are unchanged.
