# Durable upload processing

Additive queue and restricted dispatcher role; no existing photos change. Apply
before deploying this code (including with the queue feature flag off): receiving
admission, status, cleanup and routing queries now reference this table.

Do not apply or deploy yet. Back up and verify restore before the normal migration
workflow. Existing uploads can continue synchronously during an additive rollout.

The migration creates `personal_photos_upload_queue` as NOLOGIN. Provision its
password/login separately and store it as `PG_UPLOAD_QUEUE_SECRET`; never put the
password in Git or command-line logs. This credential can dispatch jobs and read
routing; it has no media-catalog, routing-write, or maintenance privileges. The
worker also uses the existing app credential under the accepted uploader's scoped
identity. No maintenance credential is added to the upload container.

See `docs/queued-upload-processing.md` for the staged activation and rollback order.
Do not remove the table on rollback while jobs or sessions still exist.
