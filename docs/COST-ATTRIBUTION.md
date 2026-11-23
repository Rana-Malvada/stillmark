# Cost attribution and chart

## New work

`costWork` saves a UUID, purpose and owner weights in Postgres before executing billable work. The Snowflake statement receives `QUERY_TAG=personal-photos:<UUID>`. The report joins that identifier to the saved task. Photo/video classification does not depend on the model, prompt, SQL formatting or file path. Failed attempts can still incur credits and retain their task record. Tags contain no user identity.

AI usage reads `QUERY_TAG` directly from `CORTEX_AI_FUNCTIONS_USAGE_HISTORY`. Personal AI uses the same usage snapshot as the all-user report. Warehouse attribution uses `QUERY_ATTRIBUTION_HISTORY`; account totals use warehouse metering, including idle time. These represent different charges from AI function credits.

## Historical work

Legacy tasks recorded only `ai`; some manual work had no task tag. `cost_ai_history` freezes reviewed classifications by query ID and function name, with provenance. Run the bounded, explicit backfill script described in `migrations/postgres/202610061430_cost_ai_history.md` only after reviewing its results. The script contains legacy query signatures; the live app does not execute those signatures. Repeated backfills cannot overwrite accepted records. Unknown history remains **Unattributed AI**.

Old cached reports remain readable until refreshed. Historical `HISTORY_KIND` fields are compatibility data in those already-saved snapshots; fresh reports use `VERIFIED_KIND` from the ledger.

## Search embeddings: count once

Snowflake reports Cortex Search embeddings in both AI usage and search service usage. The live report matches embedding query IDs to dynamic-table refresh metadata for the two application search services. Those records are excluded from photo/video/direct-embedding totals. The separate Search AI — add to search row uses the service usage source once. Other embedding work remains separate.

Refresh metadata takes precedence over an inherited photo/video task tag. Historical search records missing refresh metadata can use the immutable ledger. If a new refresh has not yet appeared in Snowflake's delayed metadata, its embedding charge is held out of the AI categories and the report explicitly warns that totals are partial. The report does not guess or count it twice. A later manual refresh resolves it when metadata arrives.

## Photo descriptions sent to OpenAI

When `PHOTO_AI_PROVIDER=openai` (see [AI descriptions](AI-DESCRIPTIONS.md)), those requests are not Snowflake usage. The ledger stores their token counts and a dollar estimate at OpenAI list prices (`pricing_version` beginning `openai-`). The report keeps them out of the Cortex REST section, so they are neither priced in credits nor flagged as charges awaiting Snowflake billing, and lists them as **Photo AI — OpenAI (direct)** in dollars, attributed to the album owner. The line and its chart series appear only when such requests exist in the period. Requests OpenAI rejected carry no amount and are not counted.

## Chart behavior

- Default **All · Total cost** plots one daily total line from the server's reconciled daily amounts.
- A compact Cost types dropdown contains checkboxes for comparing multiple categories, with named lines and a legend. It closes with Done, Escape or an outside click.
- Removing the last selected category returns to Total cost.
- All does not plot every category or add a total to those categories.
- Zero is a reported zero; unavailable values remain unavailable.

The total is an estimate of reported services, not an invoice. Storage run-rate and unmetered transfer dollars are separate; missing/unallocated costs, Cloudflare, Auth0, taxes and contract adjustments are excluded. Prices and existing allocation methods are unchanged. Reporting is cached and only an authorized explicit refresh contacts Snowflake, with a 15-minute limit; chart selection uses existing data locally.

## Security and operation

The historical ledger has forced RLS. Only the maintenance login can select/insert, and reporting still requires the existing API authorization. The web login and GPU worker cannot access it. No GPU pool is started by these changes. Deployment follows `docs/SAFE-RELEASES.md` after the additive migration and historical backfill.
