# Settled inference receipt retention

Compatibility: this adds a partial index to the receipt table from `202610291910_photo_inference_receipts.sql`. It also adds an invoker-security pruning function executable only by the existing maintenance role. It changes no rows, role memberships or RLS policies. Apply before enabling the new cleanup code. The migration uses a five-second lock timeout and must fail on lock contention; do not suppress errors. Follow the normal backup/restore gate.

The existing Postgres-only AI reconciliation pass deletes at most 100 receipts older than 90 days, and only when the provider result was received, its billing ledger was recorded, and the attempt is retired or its photo was deleted. It does not create a timer, use a warehouse, call the provider, delete media or alter the cost ledger. Active receipts, pending ledger reconciliation, prepared attempts and uncertain dispatched attempts are never age-deleted. Unknown outcomes require review rather than automatic paid retry.

`PHOTO_AI_RECEIPT_RETENTION_DAYS` accepts 30–3650 days; the default is 90. Zero disables pruning. Age is measured from the receipt's last update, not the date it became retired. New successful late responses update the receipt timestamp. This is operational recovery data, not the billing record.

Verification: `tests/photo-inference-recovery.test.ts` covers received/unsettled/unknown/active/orphaned cases, batch bounds, idempotence, disabling, validation and role isolation. No deployed retention or query-plan claim is made; inspect the index plan on representative production cardinality during release verification.

Rollback: roll back the application code or set the retention value to zero. The additive index may remain. Pruned inactive receipts are not recreated by code rollback; use a backup if they must be recovered. Original media and cost records are not touched by this change.
