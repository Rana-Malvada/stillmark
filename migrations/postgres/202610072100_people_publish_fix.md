# People: publication duplicate and count fix

Replaces `face_worker.publish` (same signature, `CREATE OR REPLACE`). No table, policy or
grant changes; existing `EXECUTE` grants on the function are preserved.

## Problem

The overlap rule that preserves a face confirmed in an earlier scan compared each new
detection with every `detected` face of the photo, including detections inserted moments
earlier in the same call. Overlapping boxes from the second, tiled detection pass were
dropped and their crops queued for cleanup, but still counted in `faces_found`
(1,296 counted versus 842 stored; 454 crops queued). Dropping duplicates was desirable;
doing it implicitly, inconsistently and with wrong counts was not.

## Change

- The worker now removes duplicate detections (IoU >= 0.4, or a box more than half inside
  a higher-scoring box) before publishing.
- Publication compares only against faces with a **confirmed** assignment.
- `faces_found` counts rows actually stored plus kept confirmed faces.
- A detection skipped by the unique index queues its unused crop for cleanup.

## Compatibility

Same signature and return type. The worker image that calls it (`cpu-v3`) also sends
explicitly typed parameters; older images still work with this function.

## Verification

`npx vitest run tests/people-worker.test.ts`, including adjacent faces in one photo,
counts, preserved confirmed faces and the worker's exact SQL with psycopg-typed
parameters. After apply:

```sql
SELECT pg_get_functiondef('face_worker.publish(integer,uuid,text,text,jsonb)'::regprocedure)
  LIKE '%a.status=''confirmed''%';
```

## Recovery

Forward-fix only; do not edit this applied file.
