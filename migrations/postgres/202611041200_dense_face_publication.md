# Dense face publication

## Compatibility

Compatible with the deployed cpu-v6 worker and existing app. Expands the bounded
publication payload from 200 to 5,000 detections without truncation. Existing
claim, owner, confirmed-face and storage protections remain unchanged. No tables,
roles, grants, or stored face records are altered by this migration.

## Verification

Verify dense images against the worker payload bound, actual worker-role publication,
row security, and rollback cleanup. Run the catalog backup/restore gate before
application and keep measured outcomes in private release evidence.
Terminal summaries count failed photos rather than retry attempts, and recovered
runs finish successfully. Oversized and malformed payloads fail before replacement.

## Rollback

Use a forward migration to restore the publish function from
202610072100_people_publish_fix.sql and finish from
202610072010_people_worker_queue.sql if necessary. Do not edit the applied file or
restore the whole database. Reverting the bound will make dense photos fail again;
existing published faces remain valid. No app or worker rollback is required.
