# Safe releases

GitHub runs [Quality gates](reference/github-quality-workflow.yml) on pull requests and
pushes to `main`. It uses Node 22, locked dependencies, disposable PostgreSQL 17,
and both Chromium and WebKit. The configured runner is `stillmark-ubuntu-24-16core`.
The hosted job runs the same `check.py` as a release;
it has read-only repository access, no production credentials, and cannot deploy.
Check the run for the exact commit before releasing. Hosted success complements,
but does not replace, the production backup, migration, and signed-in checks below.

A release does not repeat everything the hosted job did. `deploy.py` runs `check.py
--reuse-hosted-run`, which asks GitHub whether both required checks passed on a commit
with exactly the same file tree as the one being released
([ci_evidence.py](../scripts/release/ci_evidence.py)). If so, the checks whose answer
depends only on the source are skipped: type-check, unit tests, browser suites, the
disposable-database checks, the production build and the smoke test. Everything that
depends on the day or the machine still runs on every release: the secret scan,
dependency and image advisories, the deployed-image inventories, the worker image
builds, the migration state and the backup check. If the folder has uncommitted
changes, the trees differ, either check failed, or GitHub cannot be reached, nothing
is skipped. The script prints which case applied and its slowest steps.

For a fresh local checkout, install each locked package before running the full gate:

```sh
npm ci
npm --prefix cloudflare-gateway ci
npm --prefix workers/video-gpu ci
npm --prefix scripts/load-test/cloud ci
```

The last package supplies the load-harness transport tests; it is not bundled into
the application runtime.

Use `python3 scripts/release/deploy.py --connection stillmark-deploy --deploy` from a clean, committed checkout. This runs type checking, linting,
app and gateway tests, documentation links/index coverage, formatting and historical-setup integrity checks, a production build, local production access-boundary tests,
separate production and build/test dependency advisory gates, migration checks, and a fresh catalog restore drill
before invoking `snow app deploy`. It records the Git commit and previous/live
Snowflake service descriptions under `.release/`. Deployment runs from an archive of that exact checked Git commit, with its SHA-256 recorded in the release record. Ignored laptop files, temporary screenshots, caches, and untracked files cannot enter the deployment bundle. Post-deploy runtime status and gateway anonymous-access checks run automatically.
The public gateway intentionally blocks unauthenticated application health checks;
signed-in checks and the existing signed monitor cover the origin. No permanent test service is created.

The local check gate also requires native PostgreSQL concurrency checks and the
dependency-light face publication fault tests. Start local Docker and fetch
`postgres:17` and the pinned pgvector image named in
`scripts/verification/local-postgres.mjs` explicitly before running `npm run release:check`; the checks never
pull an image implicitly or accept a remote database. `npm run test:database-gate`
runs the database subset independently, including a real dump/restore of a synthetic
catalog with the selected PostgreSQL client tools: owner/viewer/read-only and sharing/revocation
permission workflows, album locking, reference-aware stage
cleanup, AI admission/notification recovery, statistics/acknowledgment races,
search deletion and bounded continuation, upload-account deletion fencing and
credential-event recovery. Each check has a three-minute deadline and a disposable loopback-only
database. Gate-owned containers are removed even after a child timeout. Evidence
under ignored `.release/database-checks/` records every result, the Git revision,
working-tree state, and a source-content hash; source changes during the gate fail
validation. A passing local run does not establish production load capacity.

The browser regression gate (`npm run test:client-recovery`) requires an installed
Google Chrome, or a Chromium executable supplied by `CLIENT_TEST_BROWSER_PATH`.
It does not download a browser. It bundles the actual folder, People, and photo-grid
components, supplies a synthetic identity/router, and intercepts API responses in
fresh browser contexts. Only its disposable loopback server is reachable. The gate
checks transport/malformed-response recovery, explicit photo-return pagination and
scroll restoration, and access denial before cached album data is displayed, with
React Strict Mode enabled. It records the browser version and fails on unhandled
browser errors. Each browser assertion retains a five-second deadline; the full
release suite has a ten-minute budget for the multi-viewport matrix on hosted runners.
This complements the production access-boundary smoke test; it is
not a deployed, authenticated end-to-end test.

Selection/navigation regressions additionally compile the real application stylesheet.
At 320px, 390px and desktop widths they enforce a single-row selection toolbar,
check collapsed browsing controls, Favorites filter apply/reset, anchored menus, Escape/outside dismissal and read-only controls, and measure grid coordinates and scroll position
before and after individual selection, select-all, clearing, anchored action menus and a
failed mutation. They also check People navigation during delayed responses and
browser Back. Set `CLIENT_LAYOUT_ARTIFACTS` to a private output directory to retain
light/dark screenshots; these synthetic fixtures never modify a real library.

Album Add/More/filter menus and person menus are also hit-tested above the sticky
selection bar; visibility alone is not sufficient. The real Leaflet renderer is
checked at these widths, after resize, and through fullscreen/reset, including
preserving a manually chosen view. Map tiles remain blocked in this synthetic test;
verify the production basemap separately in the signed-in browser check.

The shared shell uses a desktop destination rail and a single mobile top toolbar.
The current section opens a destination picker; there is no bottom app bar or reserved
bottom-menu spacer competing with Safari. Search, upload and account stay in the top
row; gallery status sits directly beside Search on mobile and desktop. Mobile album and person details use a
single contextual toolbar. Browser checks hit-test the main navigation at multiple
viewport heights, verify menus do not move the content, check keyboard focus,
confirm detail controls remain compact, and keep the Places map
ahead of optional statistics and place-name maintenance. Selection replaces the toolbar
contents without adding another row. Album owner information remains in the More menu.

## Accept a release

Sign in and verify Collection, one album, a photo, video playback/seek, and that
an ordinary user cannot access admin/private data. Check for runtime errors. Then:

```
python3 scripts/release/accept.py .release/<timestamp>/release.json --verified login-gallery-photo-video-access
git push origin main --follow-tags
```

The acceptance flag is a human attestation, not an automated browser test. Until
then the record stays awaiting signed-in verification. A failed deploy or check
never gets a successful release tag. Do not run concurrent deployments.

## Database changes

Historical `setup/` files mix Snowflake, Postgres and one-time operations. They are
inventoried in `release_control.baselines`, NOT blindly replayed or falsely marked
as applied. Current schema is the starting point. New Postgres migrations belong
in `migrations/postgres/YYYYMMDDHHMM_description.sql`. Never edit an applied file.

Run `python3 scripts/release/migrations.py check`. For a reviewed pending migration,
use `python3 scripts/release/migrations.py apply`; it verifies a backup first and
applies each file with its checksum in one transaction under a database lock.
Transaction-control statements and nontransactional operations are rejected.
Prefer additive changes readable by the current and next app. Put the compatibility
assessment and verification query in the migration's accompanying Markdown file.
Snowflake/gateway changes are separate reviewed operations, not handled by this
Postgres runner. The app runtime cannot access the release-control schema.

## Backup and recovery

`npm run backup:verify` creates a private local dump and restores it to a temporary
database on the EXISTING Postgres instance. The separately configured
`GALLERY_PG_SERVICE` (default from the deployment profile) selects the source;
Snowflake CLI connections do not select this identity. Client discovery uses PATH,
then Apple Silicon/Intel Homebrew libpq locations. Set `GALLERY_PG_BIN` to an explicit
client directory when needed; an invalid override fails without fallback. Before
creating a dump or database, the verifier checks server/client majors: `psql`,
`pg_dump` and `pg_restore` must have one matching major at least as new as the
server. The actual restore must still succeed on that server; a successful version
check alone does not establish archive/SQL compatibility. It includes public, photo_security, face_worker and
release_control schemas, data, object ownership and ACLs. Existing cluster roles
are required; their passwords are deliberately not exported. Only the built-in
Snowflake application role's unmodifiable default ACL is excluded. The temporary
database is removed afterward, including on failure.

The drill checks nonempty catalog data, referential integrity, restored security
functions and zero unscoped photo visibility. It also runs synthetic owner, unrelated
viewer, read-only owner, share/revoke and public-link/revoke workflows against the
restored policies, verifies authority-table denial and the app role's lack of elevated
grants, then rolls back all test rows. The same permission workflow runs locally in
native PostgreSQL before release. Extensions are database-level objects
outside the dumped schemas; the drill recreates the source's extensions (for example
`vector` and `pg_trgm`) before restoring and lists them in `result.json`. The
operational, database-bound `pg_cron` extension is excluded only after recursively
checking that objects in the dumped schemas have no recorded dependency on it.
A dependency blocks the drill for explicit scope review; no server configuration
is changed. `excludedOperationalExtensions` records the exclusion. Monitoring
schedules and operational extension configuration therefore need separate recovery.
A real recovery must create the required catalog extensions first. It is not a backup of media bytes,
Snowflake/Auth0/Cloudflare secrets, or disaster recovery to a new account. Local
backups are excluded from Git; keep a separate protected copy for laptop loss.
Never restore a dump over production automatically: first restore to a separate
database, verify catalog/media references and permissions, then plan cutover.

## App rollback

Open the failed release's `release.json` and read `before[].source.version`.
Confirm that version is compatible with the CURRENT database and secret mounts.
Do not use a historical version number copied from documentation. Replace the
placeholder below with the recorded compatible version (for example, the literal
SQL token `VERSION$<number>` with its actual number):

```sql
ALTER APPLICATION SERVICE PERSONAL_MEDIA.APP.PERSONAL_PHOTOS_APP
  UPGRADE TO VERSION <RECORDED_COMPATIBLE_VERSION>;
```

Wait for RUNNING / is_upgrading=false using DESCRIBE APPLICATION SERVICE, run
`npm run release:postcheck`, then repeat signed-in checks. A version switch does not
undo database migrations or restore changed service configuration. Preserve the
corresponding app.yml in Git. Do not run a blind `snow app deploy` from old code.

Reference: https://docs.snowflake.com/en/sql-reference/sql/alter-application-service

## Scope and cost

HA and workload limits are unchanged. Tests run locally; restore drills temporarily
consume existing database storage and I/O, and normal Snowflake builds still have
their usual cost. The GitHub quality workflow selects the configured
`stillmark-ubuntu-24-16core` runner. Runner capacity, billing and available minutes
follow that account's runner configuration; this guide does not assume standard
hosted pricing or included minutes. It does not add production compute. Direct CLI deployment remains technically possible; use this checked
command rather than bypassing it.

## What each scan proves

Two scans look at worker images, and they answer different questions.

| Scan                                                         | What it examines                                                                                    | What a pass proves                                                                                   | What it does not prove                                                             |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Source build (`scripts/release/check_worker_images.py`)      | Images built now from current source. A build installs the operating-system updates of that day     | Current source builds into images that work and have no fixable or unreviewed HIGH/CRITICAL advisory | Anything about the images that are running: they were built earlier                |
| Deployed images (`scripts/release/deployed_images.py check`) | The recorded software inventory of each pinned, deployed image digest, matched against today's data | The running images have no advisory that has since become fixable and none without a current review  | Files the scanner could not attribute to a package when the inventory was produced |

Both run in every release gate and in the weekly CI run. The deployed-image check names
the digest each result is about, and fails, rather than passing, when a pinned image
has no recorded inventory for exactly that digest. When it reports a fixable advisory,
the remedy is to rebuild and release that worker image.

`security/deployed-images/manifest.json` lists, per worker, the pinned digest and the
SHA-256 of its inventory file. Whenever a worker image pin changes, record the new
image's inventory in the same pull request:

```bash
python3 scripts/release/deployed_images.py record upload-cpu <local image ID>
```

The command refuses an image whose ID is not the pinned digest. The check's limits
(it reads the pins, not the running services; reviews are bound to current source) are
listed at the top of `scripts/release/deployed_images.py`. The natively compiled
components of the video image are built from pinned source versions, so the source
build rescans exactly what is deployed; they are not in this inventory.

## Actual worker images and dependency security

The required `scripts/release/check.py` gate now builds all four production worker
images for Linux/amd64 and runs `scripts/release/check_worker_images.py`. It tests
real installed HEIC decoding, face detection/embeddings and recovery, OCR/CLIP and
reranking, plus video bundle/FFmpeg execution. A public-domain NASA portrait is
mounted for face model checks; no private gallery photo or production credential
is used. Model tests run offline against the models already in the image.

Each image is resolved to its immutable local image ID before testing and scanning.
Pinned Trivy produces a CycloneDX SBOM and a complete OS/Python/Node vulnerability
report in `.release/worker-images/<run>/`. Fixable HIGH/CRITICAL advisories block the
gate. Unfixed HIGH/CRITICAL advisories also block unless
`config/package-advisory-reviews.json` contains a valid explicit disposition for
that worker scope, package class/name/version, advisory and severity. A native-donor
package review uses `<worker>:native-donor` as its scope. The exact review records
exposure, mitigation, reason, reviewer, the accountable owner who approved it
(`approvedBy`, `approvedAt`), dates, primary-source evidence links and
source/configuration SHA-256 bindings. Expired reviews, changed bindings and any review valid for more than 30 days fail
closed. The full gate also runs weekly in CI, so a newly published fix is noticed even
when nothing is being released (see [what each scan proves](#what-each-scan-proves)). No review can waive a fixable package finding. Reviews start empty;
previous scan counts or general upstream-risk notes are not approvals.
Unfixed advisories, including reviewed exceptions, remain in `summary.json`; they
are not suppressed, counted as fixes or claimed safe. Counts deduplicate package/version/advisory tuples, and distinct
advisory counts are also retained. Package scanning does not prove exploitability.
The video build helper independently applies this same artifact scan.

`scripts/release/npm_security.py` retains full npm audit JSON for both production
and all-dependency sets in `.release/npm-advisories/<run>/`, plus separate runtime
and build/test findings. It checks the app, gateway, video worker and isolated load
harness locks. Runtime HIGH/CRITICAL findings continue to block. Dev-only
HIGH/CRITICAL findings require their own exact, expiring disposition in
`config/build-advisory-reviews.json`, with the project path as scope (`.` for the
app), class `npm`, installed version and npm advisory source ID. These reviews
have the same evidence and source-binding requirements as image reviews. A build
advisory describes build/test exposure; it does not by itself establish a runtime
exploit. Partial registry reports and missing lock entries fail closed. CI retains
these reports alongside actual-image evidence.

Worker bases are pinned to registry digests. Python runtime dependencies and their
transitives use platform-specific hash locks and `pip --require-hashes
--only-binary=:all:`. Regenerate with uv 0.9.7 using
`python3 scripts/release/lock_workers.py`, review the changes, and rerun the image
gate. The search lock explicitly installs CPU PyTorch; it does not add CUDA.
Debian/Ubuntu package security updates are intentionally applied during builds; apt
repositories are not frozen. Therefore rebuilds are **not bit-for-bit reproducible**:
retain the SBOM and tested image ID, push that exact image, and deploy its resulting
registry digest. Never rebuild after validation and assume the new image passed.

The video runtime additionally inventories every shipped vendor ELF file and
symlink against the pinned component/source inventory. Pinned Grype scans this
native SBOM because OS package metadata misses bundled libraries. Every raw
finding remains in the evidence. Unreviewed HIGH/CRITICAL native findings block;
applicability reviews bind exact component versions, architecture, source patches,
configure flags and application command paths. Changes invalidate the review.
Reviewed but unpatched findings are reported separately, never counted as fixed.
Native CPE matching is incomplete; statically embedded compiler revisions and
manual advisory checks are recorded with those limitations.

The video build applies the reviewed upstream CFHD, FLIC and zlib patches and
builds libxml2 2.15.4 from pinned source. It requires zlib/libxml2 tests, FFmpeg unit
tests and official CFHD/FLIC FATE samples. Their logs and configure evidence are
retained in the actual image and exported by its security gate. It removes optional
Intel/AMD device-driver payloads only after proving they are outside the required
dynamic-link closure; codec, demuxer and filter support remains intact. Final
CUDA/NVENC, rotation, HDR and stage-permission checks require an isolated L40S job;
a CPU-only image gate cannot substitute for those checks.

The native build has an optional local BuildKit cache. A miss builds from pinned
public source; no private image is required. A hit must match all native source,
patch and build inputs, the complete installed package/toolchain inventory and
platform. Every archive and extracted file is checked. Cache integrity does not
replace final image scans, CPU regressions or GPU tests. Exploratory builds must
not be relabeled as authoritative cache entries. The quality workflow exports
only the native cache plus a commit/run receipt. Before the release gate, CI
checks up to the latest 100 successful runs on the repository's default branch.
It automatically restores the newest available compatible ancestor from a
same-repository push or manual quality run; pull-request artifacts are excluded.
The download step has a read-only Actions token. Missing, expired or incompatible
caches use the normal source build; malformed provenance or tampered artifacts
fail the gate. To import a specific successful run manually, use
`python3 scripts/release/native_cache_transfer.py --import-run RUN_ID
--source-commit COMMIT`. The helper verifies this repository, workflow, successful
run, ancestor commit, exact current inputs and artifact hashes before seeding the
cache. Compiler/platform identity and extracted-file hashes are checked again
inside the final build. Application source and its commit ID are not native-cache
inputs, so ordinary app changes reuse the compiled libraries. The complete
Dockerfile recipe remains conservatively bound: recipe edits, native inputs,
base images or installed compiler/package changes can require a cold build.
CI preserves artifacts for 90 days, subject to repository retention policy and
manual deletion. Availability is not guaranteed; expiry, eviction, or no compatible
entry among the inspected runs causes a source build. Successful builds renew the
export. Reuse never bypasses current image scans, behavior tests or GPU validation.

The repair and benchmark Dockerfiles are development/one-time utilities, not the
four deployed services. Their base arguments have no mutable defaults: supply an
immutable `repository@sha256:...` reference from a verified image. The repair
algorithm is exercised in the face-image gate. Any separately published derived
image must be scanned in its own right using `image_security.py`; a parent-image
scan is not evidence that added code was tested.

The current native permission fixture uses pinned pgvector PostgreSQL 17 locally
and applies the current registration, shared-collection, deleted-account, gateway
and upload-authority chain. Fetch that pinned image before local validation (the
GitHub workflow does so explicitly). CI preserves database and security evidence
for 14 days and reserves disk space for real worker images. No production objects
are created or modified by these gates.
