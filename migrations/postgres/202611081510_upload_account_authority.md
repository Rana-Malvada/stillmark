# Account deletion and upload publication

Apply this forward migration through the normal backup/restore and checksummed
migration process before releasing the matching app and upload-worker code. It
requires the existing application-permission, customer-account, and upload-queue
migrations. No new secret, role, compute pool, or state enumeration is needed.

Customer-mode upload processing now checks the live registry, principal permission,
and deletion state before reading or transforming staged media. Enqueue, completion
claim, album creation, and publication repeat the check in their transaction, before
queue/session or catalog row locks. The shared per-owner transaction advisory lock fences those operations
against the exclusive lock taken by self-service account deletion. A publication
that wins the lock commits first; once deletion commits, later publication fails.
Locks are not held across media work, and another owner's uploads remain independent.

Deletion removes only that account's unfinished upload sessions. Existing foreign
keys remove their processing jobs, chunks, and chunk-write reservations. Cancellation
does not create a failed job or an operational failure alert. Completed session
results, published media, and other users' jobs remain intact. Existing durable
`stage_cleanup` intents remain; removed sessions no longer protect their staged
chunks, so normal cleanup can reclaim them. Prepared but unpublished media also
retains its existing cleanup intent. No immediate external storage deletion occurs.

The migration leaves the global authorization epoch unchanged. The runtime guard is
enabled with `CUSTOMER_ACCOUNTS_ENABLED`, matching the existing customer lifecycle;
legacy Snowflake-authority deployments retain their existing behavior. The new helper
is executable only by the app role and accepts only the scoped caller's own username.
The restricted queue role receives no new authority.

During a mixed-version rollout, deletion's explicit queue-before-session lock order
and removal of pending sessions also fence older publishers through their existing
lease/session checks. New worker code adds the early live check to avoid unnecessary
processing. Roll back runtime code only while retaining this migration and the
pending-session cancellation behavior. Do not restore the former deletion function
while customer deletion is enabled.

Validation:

- `npx vitest run tests/customer-accounts-postgres.test.ts tests/upload-processing-worker.test.ts tests/upload-processing-enqueue.test.ts tests/upload-publication-fencing.test.ts tests/upload-folder-required.test.ts`
- `node scripts/verification/upload-account-authority.mjs`

The native PostgreSQL check uses only a disposable loopback Docker container with
synthetic rows and exercises both race orders, worker disconnect, deletion rollback,
cross-owner isolation, cleanup retention, and successful replay retention. It makes
no production, stage, or AI-provider calls. Full catalog/permission-function behavior
is exercised by the PGlite customer-account regression using the real migrations.
