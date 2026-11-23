# Permission-aware travel summaries

## Compatibility and activation

This additive migration creates per-album summary state, geographic-area summaries and exact-coordinate summaries. Statement-level photo triggers invalidate only albums whose dates, location fields, album membership, thumbnail availability or photo membership changed. Caption/description and processing bookkeeping updates do not invalidate maps. Existing map code and old workers remain compatible.

Keep `TRAVEL_SUMMARIES_ENABLED` unset/false until this migration is installed and the updated search CPU worker image is available. Enable it in the app manifest only after release checks; the app passes it to newly started Update Search jobs. `TRAVEL_SUMMARY_MAX_ALBUMS` is 100 by default, valid 1–1000. No job starts automatically. An admin-started batch rebuilds at most this many albums after OCR/ranking, within its existing heartbeat/cancellation/time budget. Work uses Postgres, not a Snowflake warehouse. The worker image now includes `travel_summaries.py`.

Cold, dirty or unfinished albums use raw photo rows. Fresh summaries and raw fallback are selected in one SQL snapshot, so there is no stale-summary window or double counting. Enabling before the first rebuild is correct, but gains no preaggregation benefit for dirty albums. A failed or canceled rebuild leaves the album dirty and retryable. Cancellation is checked between albums; an in-flight SQL rebuild may finish before cancellation is observed.

## Data and authorization

Area summaries group by album, capture year, rounded coordinates, country and city. Point summaries retain exact coordinates and per-coordinate counts, allowing exact viewport boundaries, weighted centers and distinct-location counts across albums. No multiresolution approximation or viewport candidate cutoff is introduced. Unique coordinates may still produce nearly one point-summary row per photo; this is not a constant-cost map index.

Album names, ownership, visibility and fallback years are joined live. A year-less capture group merges with a dated group when the current album fallback year matches it. Thumbnail representatives are selected using the same preference as the original query; thumbnail paths come from live photos. Album deletion cascades the summaries. Sharing/revocation needs no rebuild.

All summary tables use forced RLS based on the existing readable-events policy. The application role has SELECT only. The SECURITY DEFINER builder has a fixed search path, no caller-provided SQL or album ID, and is executable only by the maintenance and search-worker roles; PUBLIC execution is revoked. The trigger function is also not executable by PUBLIC. These are trusted existing background roles, not end-user grants.

A rebuild locks the parent event before summary state to avoid a lock-order cycle with album deletion, skips busy candidates, and rebuilds one album transactionally. Photo invalidation and summary publication serialize on the same state row. A source change committed after a build makes it dirty again. The candidate scan is bounded to 100 dirty albums per call. A very large album must fit the worker's SQL deadline; failure preserves raw fallback rather than publishing partial aggregates.

## Verification and rollback

`tests/travel-summaries.test.ts` compares raw and summary reads while cold, partially built and warm. It covers exact viewport edges including both sides of the dateline, year fallbacks, undated media, invalid GPS, duplicate points across albums, thumbnail changes, photo moves/deletes, live sharing/ownership and direct-table RLS. Worker tests cover opt-in, per-run limits, cancellation and errors. `npm run test:travel-summaries-postgres` verifies edit/build, delete/build and rollback races on disposable local PostgreSQL, not production.

Install through the standard migration/backup gates. Index creation uses a five-second lock timeout and must fail on contention. No production migration or worker image deployment is included in this source change. Representative production query plans, summary reduction ratios and worker duration remain release validation tasks.

Rollback reads by disabling `TRAVEL_SUMMARIES_ENABLED`; raw map queries remain available. Existing tables/triggers can stay installed during an application rollback. To remove them later, first drain summary workers, remove the three `travel_*` photo triggers and the two summary functions, then remove the three tables. Summaries contain derived data only; never remove source photos or album grants.
