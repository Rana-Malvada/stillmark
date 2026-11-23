# Historical AI cost classifications

Adds a small append-only ledger keyed by Snowflake query ID and function name. It stores a reviewed purpose and provenance, never SQL text, prompts, media paths, or identities. New work remains classified through existing query tags and `cost_work` categories.

## Rollout

Apply with the standard migration runner (which verifies a catalog backup first). Preview `scripts/costs/backfill-ai-history.py --cutoff <fixed past UTC timestamp>`, inspect category counts, then use the same timestamp with `--apply`. This is an explicit historical operation; normal report refreshes never execute legacy SQL signatures. Unrecognized history stays unattributed. Duplicate inserts do not alter accepted classifications.

## Permissions and compatibility

RLS is enabled and forced. Only the maintenance login can select and insert; the web login, public links, and GPU worker have no access. Existing report/cache structures remain readable, so the old app continues to work during rollout. The new app requires this table before deployment.

## Verification

Check counts by `kind`, ensure `relrowsecurity` and `relforcerowsecurity` are true, and verify the web login lacks SELECT. Compare credits by category against the previous cached report and reconcile aggregate AI credits. Test changed SQL/model names, inherited search tags, pending refresh metadata, and the total chart.

## Rollback

Roll back application code without removing the ledger. It is additive and does not change media, costs billed, task ownership, or existing task records. Do not delete evidence during rollback.
