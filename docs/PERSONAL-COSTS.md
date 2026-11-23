# Personal and administrative cost reports

The Costs navigation item opens `/costs`. `/admin/costs` renders the same report for administrators.

## Access

- Ordinary users receive only their own report. Selecting another username or `all` is rejected on the server.
- App Owners (including legacy main administrators) can choose All users or an individual user.
- Existing admin/read-only-admin visibility of overall totals is retained. Read-only admins cannot refresh usage or change data.
- The personal endpoint returns only the filtered report, never the cached account report, attribution ledger or another user's usage records.

## Allocation

| Category            | Calculation                                                                                                                                                                                                                         |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL compute  | Production-only configured running-hour estimate, split by membership time in each day.                                                                                                                                             |
| App Runtime         | Production-only single-app baseline estimate, with the same membership-time split.                                                                                                                                                  |
| AI descriptions     | Actual AI usage credits joined to an opaque query tag and the album owner captured when work starts.                                                                                                                                |
| Warehouse compute   | Query-attributed credits for tagged AI/sync work, allocated to captured owners. Idle time, untagged work and queries too short for Snowflake attribution are excluded from personal totals.                                         |
| Add to search       | Daily search embedding credits split by content-size weights submitted for each service on the refresh day. Approximation, not measured per-user tokens. Tagged sync compute appears in warehouse compute to avoid double counting. |
| Search availability | Production serving credits split by membership time each day, including partial signup days.                                                                                                                                        |
| Media storage       | Current original-media size including retained trash, converted to a monthly run rate. Not historical storage spend.                                                                                                                |
| Transfers           | Recorded successful-upload and requested-download sizes only; no invented transfer charge.                                                                                                                                          |

GPU video conversion, face/search batches, and upload processing use metered Snowpark Container Services credits, filtered to the exact production pool names in `lib/costs/cost-pools.ts`. Unidentified legacy aggregates remain unavailable. The same allowlist is applied when reading cached reports so unrelated pools cannot enter totals. Startup and idle time are included in pool metering. Daily totals are shared by membership-seconds, using the same partial-day allocation as hosting. These are estimated user allocations of measured pool costs, not measurements of individual job consumption. Viewing the report reads Postgres only; the explicit administrative refresh collects the upload pool along with the other sources.

Photo descriptions appear in a single **Photo AI** row. Recorded REST charges and attributed historical SQL charges within the reporting window are added once. The retired **Photo AI — SQL** row is removed; its historical charges remain in the total until they age out. Charts and service totals use the same combined category.

Cloudflare and Auth0 are excluded. Rates are explicit list-price assumptions: $2/credit and $23/TB-month. Discounts, taxes, database storage, thumbnails, previews, temporary chunks, backups and other services are not included. Storage is not included in the compute subtotal.

Production hosting and database estimates use `config/production-cost-estimates.json`, not the combined account billing rows. The report ends at the cached usage snapshot, clips the current day, and uses actual Eastern day lengths, including DST. The configuration assumes continuous production operation from October 1, 2026. Historical uptime is estimated, not reconstructed from lifecycle events.

- **PostgreSQL:** one AWS BURST_S without HA, 0.0136 credits/hour. This uses the current published rate for the configured period; 720 hours is 9.792 credits or $19.584 at $2/credit.
- **App hosting:** one production application, 0.0297 estimated credits/hour; 720 hours is 21.384 credits or $42.768. This is a calibrated single-app hosting baseline, not a claim that the published serverless multiplier is a node-hour rate. The October 8–9 baseline had 48 hourly observations with median 0.02967525 credits/hour. Shared node packing, builds, and resource changes can make billed usage differ.
- **Allocation:** each day's estimated credits are divided using member-seconds between signup and deletion, clipped to that day and snapshot. A new member receives no costs from earlier days. Retained deleted-account membership dates preserve historical allocation. Missing membership dates remain unallocated. The shares sum to the daily estimate when membership is known and at least one member exists.

To change resource sizing or rate assumptions, close the existing period and append a new one. Record suspension with zero units. Do not overwrite an old period to change future pricing. Missing coverage and invalid/overlapping periods are unavailable, not zero. Update the configuration when production resources change; there is no automatic uptime discovery on a page read.

Sources: [Postgres pricing](https://docs.snowflake.com/en/user-guide/snowflake-postgres/postgres-cost), [service consumption table](https://www.snowflake.com/legal-files/CreditConsumptionTable.pdf), and [App Runtime billing](https://docs.snowflake.com/en/developer-guide/snowflake-app-runtime/cost). Rates and assumptions were reviewed October 31, 2026.

## Attribution and gaps

`cost_work` stores immutable owner weights and work IDs. Snowflake statements use `QUERY_TAG=personal-photos:<opaque ID>` as a statement parameter; pooled connections explicitly clear tags outside attributed work. Usernames are not placed in tags. Failed/retried AI statements can still incur attributable cost.

Successful sync merges record content-size weights in `cost_index_weights`. Refresh submissions capture pending weights since the previous successful sync. Embedding estimates use refresh submissions, not the administrator who clicked Sync. Deletion-only operations, old untracked changes, internal untagged refresh queries and refreshes without recorded weights remain unallocated. Retry/rebuild weighting and refreshes crossing UTC dates are approximate; daily billing views cannot provide exact per-user embedding charges.

Historical AI and warehouse costs are not backfilled using current ownership. Ownership transfers affect future work, not prior ledger records. Current storage estimates use current ownership.

## Refresh and deployment

The original tables were introduced by `setup/35-personal-costs.sql`. That file is
frozen history, not a deployment step. Use the [forward migration process](SAFE-RELEASES.md)
to inspect and apply pending changes. Refresh jobs persist their state and report output in PostgreSQL so reads work
across devices and a refresh can finish after the requesting page closes.

An admin refresh uses the existing 15-minute cooldown and fetches the reporting sections. It can wake COMPUTE_WH. Personal page loads only read PostgreSQL/cached usage; no automatic cost-query polling was added. Snowflake data can lag up to eight hours. Failed sources remain unavailable rather than zero; subtotals include available categories only.

The All users view includes available production totals, including amounts without a known member allocation; it excludes combined account hosting and database totals. It is an estimate, not a billing or payment system.

### Storage request reductions

Storage operations use a private, storage-only Snowflake connection pool. Each new
connection is checked for an absent warehouse before use; subsequent successful
operations reuse that validation. Any operation failure invalidates it, so the
next use checks again. The SQL allowlist continues to reject session changes,
warehouse selection, table queries, and appended statements.

Photo signing batching is enabled in the deployment manifest. Photo, face-crop,
and upload-chunk signing share a bounded process-local queue (32 expressions per
statement, four statements in flight). Face and chunk URLs have a bounded internal
cache with a 30-second expiry margin. Face routes still check live permissions
before signing or using a cached URL, and responses remain private/no-store.
Upload completion signs up to 16 upcoming chunk URLs together but reads and
verifies each chunk sequentially; this does not buffer 16 chunks in memory.
Rejected chunk signatures are invalidated for the next completion retry.

Manual cost refresh no longer fetches the unused account-wide App Runtime and
Postgres aggregates. Production-only estimates described above remain the source
for those categories. These reductions remove SQL requests, not all cloud-services
work. Dollar savings must be measured against comparable workloads; no percentage
reduction is assumed.
