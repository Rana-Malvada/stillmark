# Search enrichment and saved-query reranking

Finite CPU job on the dedicated PERSONAL_PHOTOS_SEARCH_CPU pool, separate from face scanning. No always-on
compute and no GPU in the live query path. Model files are pinned by revision and
baked into the worker; runtime model downloads are disabled.

- OCR: Tesseract, English, EXIF-oriented image capped at 2400px. Text and confidence
  are evidence, never a recognized identity or an exact assertion about a race number.
- Visual: OpenAI CLIP ViT-B/32, normalized 512 dimensions. Image revisions fence
  publication. The app's pinned FP32 ONNX text encoder was cross-checked against
  this model (>0.99999 cosine on the compatibility examples).
- Ranking: MS MARCO MiniLM L6 text cross-encoder. Private saved query/candidate pairs
  only, with revision and lease checks. No arbitrary SQL is accepted from a model.
  This is an evaluation candidate, not a claim that web-passage training is optimal
  for this photo library. SEARCH_BATCH_RANKING_ENABLED gates serving the new order.

## Operation

With `AUTOMATIC_MEDIA_PROCESSING_ENABLED=true`, newly committed photo sources
create durable OCR admission signals; routine retries and pre-existing backlog do
not. The coordinator admits exact photo membership and starts a deterministic job.
New eligible uploads join an active automatic run. Its model processes stay warm
for 15 minutes after their last work, within the original run deadline. Warm idle
is reported separately from processing. The application coordinator admits new
uploads on its maintenance tick; the warm worker checks admitted work every five
seconds. No remote calls occur in the upload transaction.

Main admin: Activity → Processing exposes progress, Stop, and explicit recovery.
Manual OCR runs retain their requested photo/search budgets.
Each worker stops after 3000 seconds; the app automatically records and launches
another photo worker for the remaining requested photos. The entire update has a
three-hour deadline measured from the original request, including startup and
follow-up work. The container calculates its remaining time at startup and enforces
that deadline with a hard timeout; continuation never resets the clock.
After photo work finishes, a nonzero search budget publishes metadata and refreshes
retained searches, then starts a rerank-only job. That child cannot recursively
start additional jobs. Stop cancels active work or a pending continuation under the launch lock. If
publishing holds that lock, Stop reports a retryable conflict rather than claiming
to have cancelled. The atomic continuation insert also checks the parent status. Unfinished items stay queued. Child creation and
parent linking are atomic; interrupted submissions recover the same job ID. Expired leases retry at most three times.

Photo and reranking inference run in warm, isolated child processes. The parent
keeps the run heartbeat and renews only unexpired, still-owned claims while a
child is busy. Individual photo work defaults to a 180-second deadline and
reranking to 300 seconds, including model initialization. The optional
`SEARCH_PHOTO_TIMEOUT_SECONDS` and `SEARCH_RERANK_TIMEOUT_SECONDS` settings are
capped at 600 and 900 seconds respectively; neither extends the original run
deadline. A timeout, native crash or Stop terminates the affected process group,
including OCR descendants, with forced termination if needed. A timed-out slot
is replaced for subsequent work; healthy slots and warm models remain available.
Timeouts use the existing three-attempt item budget and publication fences.

`test_search_inference_liveness.py` exercises real hung and TERM-resistant
children, crashes, slot replacement, Stop, lease loss, parent I/O stalls and
reranking deadlines. The actual-image `test_worker.py` also sends real OCR/CLIP
and ranking work through the production warm-process adapter. These are bounded
liveness/model checks, not a production throughput benchmark.

Cached results are user-owned under RLS. Replays use a conservative current read-only
identity, never an admin credential. Formerly privileged scopes are skipped rather
than expanded. No paid LLM runs during replay. Search sessions expire in 14 days and
are limited to 50 per user. Current permissions and catalog revision are checked on
every page. A new search uses the latest valid ordering; paging keeps its ordering.

## Deployment

Apply additive migrations using the checked migration runner. Provision a distinct
Postgres login/secret for personal_photos_search_worker; provision.sql supplies
a suspended dedicated CPU pool and Snowflake rights on the repository and read-only original stage.
Apply the pool provisioning before deploying the app configuration that selects it.
The pool has one CPU_X64_M node and automatic resume disabled. New provisioning
uses a 900-second pool idle limit; existing pools may retain 60 seconds. A running
warm job keeps its process/model pool alive independently of that pool setting. Existing jobs finish on their original pool; new jobs use the dedicated pool.
Build linux/amd64, run test_worker.py offline, push a new immutable image tag, then
review/apply direct-control-grants.sql and update config/search-worker-spec.json.
Never overwrite a deployed image tag.
The app controls and worker deployment are separate artifacts.

Job orchestration runs in lib/search/search-batch-control.ts using only direct SHOW,
ALTER COMPUTE POOL, EXECUTE JOB SERVICE and DROP SERVICE commands. No CALL or
SELECT is allowed in this control path. Verified live using the runtime role,
secondary roles disabled, with CURRENT_WAREHOUSE() null. The legacy stored-procedure
path fails in that same warehouse-free session. Existing CPU jobs are not restarted
by the control upgrade. Runtime inherits the existing scoped search-worker role
and has OPERATE/MONITOR on the CPU pool; no warehouse grants are added.
Index publishing remains warehouse processing. Durable revision signals start a
bounded publishing cycle only when the Postgres index outbox has work. A cycle
survives application restarts, including an interrupted refresh after table writes
were acknowledged. Failure, Stop, or the three-hour deadline pauses the current
work; Retry search publishing explicitly queues another attempt. New source
revisions can start another cycle. Active publication checks durable cancellation
every five seconds; an already submitted Snowflake statement may finish, while
later abort-aware operations are stopped.

Private ONNX text assets from config/search-model.json are uploaded uncompressed to
its fixed derived-stage prefix. The app validates exact SHA-256 and size, warms the
model asynchronously and uses existing text search during warmup. No browser query
can choose an asset path. SEARCH_VISUAL_ENABLED controls serving visual candidates.
A cold process may issue stage-signing SQL while warming; no query waits for it.

## Performance validation

`benchmark_parallel.py` runs OCR/CLIP in isolated worker processes without database
publication. Run the candidate image with explicit CPU limits and the same private
input manifest for every comparison. Record cold/warm timing, output hashes and
memory in ignored output directories. Compare real-library recall and first-page
quality before serving changed ranking logic. A local benchmark is not a production
SLO or full pipeline capacity measurement.

Costs include both the historical shared pool and the dedicated search pool under
Face recognition and search batches, grouped by compute pool. Per-run elapsed time
and counts are retained; pool metering does not provide exact per-job credits.

Status pages refresh automatically every five seconds while visible. Their GET
requests read saved Postgres progress only; background maintenance owns recovery
and settling. Update Search reports the linked follow-up and does not show overall
completion while publishing or ranking remains pending.

### Optional map preparation

With `TRAVEL_SUMMARIES_ENABLED=true`, the existing admin-started batch also prepares dirty album map summaries after OCR/ranking. The app propagates the opt-in and validated `TRAVEL_SUMMARY_MAX_ALBUMS` (default 100, maximum 1,000) into the job specification. Preparation uses Postgres only, one album transaction at a time, sharing the batch's heartbeat and time budget. It does not launch another job. See [travel summary migration](../../migrations/postgres/202610292200_travel_summaries.md) for activation, RLS, fallback and rollback. Unit checks without model assets: `python3 -m unittest discover -s workers/search-cpu -p test_travel_summaries.py` from the repository root.

## Shared image decoder

Upload HEIC conversion and search OCR/visual input use `workers/shared/image_decode.py`.
Their decoder dependencies are pinned once in `workers/shared/requirements.txt`.
The decoder reads the primary image, applies orientation once, checks the 80 MP
limit before loading pixels, resizes to 2400 pixels, and normalizes embedded color
profiles to sRGB. It never modifies the original. Upload subprocess resource
limits stay in the upload adapter; they must not constrain a long-lived ML process.

Build from the repository root:

```sh
docker build --platform linux/amd64 -f workers/search-cpu/Dockerfile -t stillmark-search:local .
```

Both Dockerfiles run the shared native image-format contract tests during builds.
For local Python tests, install the worker requirements and set
`PYTHONPATH=workers/shared:workers/search-cpu`. The search model test suite also
checks a real HEVC-encoded HEIC through OCR and the 512-dimensional embedding
pipeline; model files must be available at `/models`.

### Native pool comparison

Use `benchmark_parallel.py --workers 6 --threads 1 --input /input --manifest /tmp/paths.json --output /tmp/results.json` with an explicit candidate image and matching resource limits.
The manifest is a private JSON array of relative stage paths. Keep manifests and
results outside Git. The script can be supplied to a candidate image without
changing its runtime. Evaluate stage download, publication, ranking and pool
startup separately from isolated OCR/CLIP processing.
