# Search updates and recovery

## Two operations

**Sync Search** publishes changed catalog records and removals to the search
source. **Update Search** runs OCR/visual enrichment and the configured publication,
replay and ranking follow-up. Photo descriptions have a separate AI queue.

The UI and durable run state distinguish processing stages. A completed CPU job
alone does not prove the whole search update is complete. Inspect pipeline status,
remaining work and errors; see [search worker](../../workers/search-cpu/README.md).

## Automatic continuation and three-hour cap

The original run sets a single deadline three hours after its creation. Startup,
processing, publication and follow-up all share that deadline; child runs do not
reset it. Finite worker batches can finish before the whole requested update.
The coordinator continues eligible completed runs while requested photos remain,
without requiring the browser to stay open or the user to click again.

[search-update.ts](../../lib/search/search-update.ts) calculates remaining work from the
root request and accumulated progress. Continuation links are created atomically;
only the latest eligible completed run can acquire a child. Worker/job recovery,
leases and fencing prevent an obsolete worker publishing over a newer owner.

Automatic OCR also recovers infrastructure interruptions after admission. A failed
worker with the infrastructure-interruption marker keeps its exact admitted photo
IDs and original deadline. Maintenance creates at most three durable successors,
with 30/60/120-second retry windows, and waits for live claims before reclaiming
expired ones. Item attempts are never reset. Terminal media failures, explicit
Stop and the original deadline do not restart automatically. A lost launch
acknowledgement retries the recorded child ID rather than creating another job.
Manual runs retain new-upload admission signals until automatic admission,
terminal processing or explicit Stop, so a manual worker interruption cannot lose
accepted automatic work.

The cap stops further continuation; it does not discard unfinished photos. A new
explicit request can process remaining eligible work after diagnosis. Errors or
lock conflicts should be inspected, not treated as permission to clear job state.
A run can reach the deadline before completing follow-up; the UI must not imply
that enrichment completion alone means the pipeline succeeded.

## Diagnose a stalled update

1. Read the latest run, its root/child chain, deadline and `pipeline_error`.
2. Compare requested budget, accumulated completed count and eligible pending rows.
3. Inspect the recorded Snowflake job and worker logs; distinguish queue/startup,
   enrichment, sync and saved-search processing.
4. Check coordinator logs and lease/claim expiry before restarting or retrying.
5. Use the existing retry controls after correcting the actual failure. Preserve
   original media, permissions, results and job evidence.

Source: [search-batch.ts](../../lib/search/search-batch.ts) and
[search-sync.ts](../../lib/search/search-sync.ts).

## Validation

The release database gate runs `scripts/verification/search-update.mjs` and
`scripts/verification/search-ocr-recovery.mjs` against native PostgreSQL. The
actual search-image gate additionally kills a claimed worker, expires its test
lease and verifies that maintenance continues both admitted photos using real
OCR/CLIP. A shortened test lease exercises renewal during inference. These are
synthetic isolated fixtures. A live check must separately confirm pending work
drains and final search results remain authorized. Do not start a load test to
validate an ordinary update.
