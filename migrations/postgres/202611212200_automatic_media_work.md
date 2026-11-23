# Automatic processing of newly committed media

Apply this additive migration before releasing the application and search CPU worker.
It does not seed any existing queue or restart old failed/cancelled work. Enable
`AUTOMATIC_MEDIA_PROCESSING_ENABLED=true` only after the compatible workers are deployed.
Rollback the application with the flag disabled; retain these additive tables/columns.

The trigger-owned outbox records new face sources, playback sources, OCR sources,
and search-index revisions. Routine retries do not generate new admission signals.
Signals are acknowledged by exact revision inside the transaction that reserves
work. The existing processing locks, source checks, permissions, and durable worker
run records remain authoritative. No upload makes a remote worker-control request.
Video AI descriptions remain manual; video preparation only makes playback renditions.
Face, playback, and OCR signals notify the existing `stillmark_photo_ai_ready`
listener only after commit. Empty payloads coalesce within each transaction; rolled
back uploads emit nothing. Search revisions do not wake that listener and retain
the slower publishing cadence. Periodic recovery still handles missed notifications.

OCR automatic runs carry explicit photo membership. New eligible uploads may join
an active automatic run; old cancelled/failed backlog cannot hitchhike on it. Manual
OCR roots retain their requested cap and acknowledge only their initial snapshot.
Automatic OCR processes retain their model pool for 15 minutes after their last work,
checking every five seconds for newly admitted work. Their original three-hour chain
limit and shorter per-job execution cap still apply. `idle_since` exposes warm idle
separately from active processing. Stop ends the run rather than waiting for warm idle.

Search publishing uses the existing bounded `syncSearch` outbox publisher and keeps
Cortex indexing scheduling suspended. A persisted publishing cycle resumes after an
application restart, including an interrupted refresh after table acknowledgement.
Failure, Stop, or the three-hour deadline ends automatic retry for the current work;
queued data is retained. Later genuine revisions can initiate a fresh cycle. Explicit
Retry search publishing remains available in Processing to retry retained work.

Validate new-source/retry distinction, no migration backfill, exact-revision races,
transaction rollback, concurrent admission, commit-before-launch recovery, Stop,
failed/deadline behavior, warm-process reuse, source membership, and application
restart during publishing. The automatic tables are maintenance-only except a
main-admin-only SELECT/DELETE policy used to acknowledge manual face/playback admission.
`node scripts/verification/automatic-work.mjs` checks real PostgreSQL notification
delivery, rollback/coalescing, and concurrent publisher admission versus Stop in
a disposable local database. It never connects to production.
