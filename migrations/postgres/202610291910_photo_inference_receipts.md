# Durable photo inference receipts

Compatibility: adds a maintenance-only receipt table and a main-admin-checked retry function. Old code does not read the table. Apply before deploying consumers. Drain photo inference before upgrade or rollback; old code cannot honor ambiguous-dispatch receipts and must not pick up those photos for automatic retry. Preserve terminal attempts for unresolved dispatches.

Verification: `tests/photo-inference-recovery.test.ts` exercises ledger failure, reuse without a second provider request, ambiguous outcomes, explicit admin retry, app-role denial, deleted-photo reconciliation and HTTP 429. Verify runtime maintenance has table/schema access and the app can execute only the guarded retry function. Reconciliation must not invoke the provider or a warehouse.

Rollback: leave receipt data, policies and the retry function installed. Do not delete receipts to unblock a retry: reconcile successful outcomes and explicitly review ambiguous dispatches first. Restore the application only after inference workers drain. Old unresolved receipt data remains evidence for reconciliation; this migration is not a destructive rollback. Standard backup/restore verification is required before application.
