# People: face worker queue and publication contract

Adds the `face_worker` schema: the only interface the face scan job uses to claim
work, publish detections, match faces and create unnamed groups. Additive; depends on
`202610072000_people_faces`. No photo is scanned by applying it.

## Design

All functions are `SECURITY INVOKER` with a fixed search path. They execute with the
face worker role's own grants and row policies, so the contract cannot widen what the
worker may touch. `EXECUTE` is granted only to `personal_photos_face_worker`; the web
application role cannot call them.

- `claim(run, batch)`: under an admission advisory lock, recovers expired leases
  (failing items after three attempts), then claims due items for the run with
  `FOR UPDATE SKIP LOCKED`, a fresh claim token and a five-minute lease.
- `renew(tokens)`, `heartbeat(run)`: lease renewal and run liveness.
- `fail(photo, token, reason)`: bounded retries with 10 s / 30 s backoff; terminal
  failures are counted on the run. Reasons are operational text only.
- `publish(photo, token, model, source, detections)`: fenced. Requires the live claim
  and that `photos.original_stage_path` still equals the claimed source. Replaces prior
  scanner output for the photo, except faces with a confirmed assignment and manual
  tags. A new detection overlapping a kept confirmed face is not duplicated, and its
  unused crop is queued for cleanup. Payloads are capped at 200 faces and validated by
  table constraints.
- `match(owner, model, auto_at, review_at)`: assigns only faces with no assignment.
  References are a named person's confirmed, good-quality faces, or every member of an
  unnamed group. The score is the mean of the best three reference similarities.
  `>= auto_at` with a clear margin (0.08) over the runner-up becomes `auto`; otherwise,
  `>= review_at` becomes `suggested`. Rejected pairs, hidden people, low-quality and
  ignored faces are excluded. Confirmed assignments are never changed (assignments are
  insert-only here, and triggers from the previous migration also forbid it).
- `unassigned`, `create_group`: clustering is done by the worker; `create_group`
  verifies every member belongs to the owner and is still unassigned, and creates an
  unnamed person with the best-quality face as cover.
- `finish(run, outcome, reason)`, `run_owners(run)`.

Thresholds are parameters, chosen per model from the pilot, not constants here.

## Compatibility

No existing object is modified. Older application versions do not reference this
schema.

## Verification

`npx vitest run tests/people-worker.test.ts` covers claim ordering and exclusivity,
lease recovery, retry backoff and terminal failure counts, stale-token and changed-
original fencing, publication and progress, confirmed-face and manual-tag preservation,
payload validation, auto/suggested thresholds, ambiguity downgrade, rejection
exclusion, reference eligibility, owner isolation, group creation and extension, and
run lifecycle. After apply:

```sql
SELECT p.proname, p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='face_worker' ORDER BY 1; -- prosecdef must be false for every row
```

## Recovery

Code rollback needs no database change. To withdraw, revoke `EXECUTE` on the schema
from the worker role in a forward migration; do not edit this applied file.
