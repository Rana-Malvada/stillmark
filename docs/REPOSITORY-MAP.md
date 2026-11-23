# Repository map

| Path                  | Purpose                                                  | Maintenance rule                                               |
| --------------------- | -------------------------------------------------------- | -------------------------------------------------------------- |
| `app/`                | Next.js routes, API handlers, styles                     | Route files are framework entry points even without imports.   |
| `components/`         | Shared and feature UI                                    | Remove only after checking imports, dynamic imports and tests. |
| `lib/`                | Authorization, data access, jobs and domain logic        | Preserve worker/script consumers as well as app imports.       |
| `workers/`            | Upload, face, search and video services                  | Each has an independent deployment/validation boundary.        |
| `cloudflare-gateway/` | Auth0 ingress, sessions and media proxy                  | Separate release; preserve compatibility with the app.         |
| `config/`             | Non-secret deployment profile, templates and search data | Edit generator inputs, then render/check outputs.              |
| `migrations/`         | Forward changes and operator notes                       | Applied SQL/checksums are immutable.                           |
| `setup/`              | Frozen infrastructure/schema history                     | Required ledger evidence; not a bootstrap sequence.            |
| `scripts/`            | Release, verification, diagnostics and document tools    | Command-line entry points need not be imported.                |
| `tests/`              | Regression fixtures and tests                            | Test discovery may use filename patterns.                      |
| `public/`             | Browser assets, licensed vendor files and branding       | Check CSS/URL/dynamic references before deleting.              |
| `certs/`              | Public trust certificate                                 | The source; worker directories hold copies checked by a test.  |
| `docs/`               | Current guides and design references                     | Keep run results outside Git; link guides from the index.      |

## How `lib/` is organised

`lib/` is grouped into one folder per domain. A domain's entry point may also exist as
a file of the same name beside its folder (for example `lib/people.ts` over
`lib/people/`); other code imports the entry point, and internals live in the folder.

| Folder               | Responsibility                                                    |
| -------------------- | ----------------------------------------------------------------- |
| `identity/`          | Verified caller, roles, sessions, revocation, account lifecycle   |
| `access-management/` | Administrative access requests, authority checks and the journal  |
| `database/`          | Transaction identity, pool admission, advisory locks, coordinator |
| `snowflake/`         | SQL, Cortex and stage access, each with its own connection pool   |
| `albums/`            | Albums, folders, sharing, public links, the album read rule       |
| `photos/`            | Photo records, pages, labels, AI description queue                |
| `upload/`            | Chunk intake, queue, processing, publication, the browser client  |
| `search/`            | Interpretation, retrieval, ranking, enrichment, publication       |
| `people/`            | Face scan control, review, corrections                            |
| `video/`             | Validation, metadata, playback preparation, analysis              |
| `media/`             | Authorized media reads, thumbnails, previews, caching contracts   |
| `costs/`             | Usage attribution and cost reports                                |
| `travel/`            | Places, travel summaries, map configuration                       |
| `observability/`     | Activity records, metrics, production diagnostics                 |

Files at the root of `lib/` are cross-cutting plumbing or deliberately pinned in place:

- **Plumbing used everywhere:** `http.ts`, `route.ts`, `flags.ts`, `log.ts`,
  `constants.ts`, `browse-request.ts`, `public-request.ts`, `postgres.ts`.
- **Shared with the Cloudflare gateway:** modules ending in `.mjs`
  (`thumbnail-cache.mjs`, `branding.mjs`, `upload-service-policy.mjs` and others) are
  imported by the gateway by path and are the contract between the edge and the app.
  Change them only with a coordinated app and gateway release.
- **Compiled into the video image:** `video-audio.ts`, `video-fragments.ts`,
  `video-playback-queue.ts` and `worker-cycle-recovery.ts` are bound by hash to that
  image's native review, and `postgres.ts` is replaced by the worker's own adapter at
  build time, so these stay where the worker expects them.

In "event" identifiers (`events` table, `eventId`), an event is an album; the user
interface says "album" throughout.

Two boundaries are enforced by the linter, not by convention: components may not
import database or Snowflake modules, and every feature switch is read through
`flags.ts`.

## Workers

| Worker       | Language          | Deployment specification                                  | Tests                                 |
| ------------ | ----------------- | --------------------------------------------------------- | ------------------------------------- |
| `upload-cpu` | Next.js (the app) | `settings.json`, rendered by `render.mjs`                 | App test suite, `smoke.mjs`           |
| `face-cpu`   | Python            | `production-spec.json`                                    | `test_*.py`, `test-in-image.sh`       |
| `search-cpu` | Python            | [search worker spec](../config/search-worker-spec.json)   | `test_*.py`                           |
| `video-gpu`  | TypeScript        | `production-spec.json`, rendered from `config/templates/` | `scripts/release/test_video_image.py` |

The release gate builds all four images and runs their tests inside the built image
([check_worker_images.py](../scripts/release/check_worker_images.py)). The inventories of
the deployed image digests are kept in `security/deployed-images/` and rescanned by
[deployed_images.py](../scripts/release/deployed_images.py); see
[what each scan proves](SAFE-RELEASES.md#what-each-scan-proves).

## Automated quality checks

`docs/reference/github-quality-workflow.yml` runs the release gates for every main-branch push
and pull request in a clean Linux checkout, including isolated PostgreSQL and
Chromium/WebKit behavior checks. It has no production credentials or deployment
permission. See [safe releases](SAFE-RELEASES.md) for local and live checks.

## Retained tooling

- [Release tools](../scripts/release) implement migrations, backup checks, gates and promotion.
- [Verification scripts](../scripts/verification) contain native database and browser probes.
- [Load harness](../scripts/load-test/README.md) is isolated testing infrastructure, not app code.
- `scripts/load-test/check-album-permissions.mjs` checks real isolated app-role permissions
  in a rolled-back transaction; it requires explicit test database/fixture identities.
- `scripts/benchmark-search-encoder.mjs` benchmarks local models from ignored
  `output/search-models/`; it disables remote model downloads.
- `scripts/repair-video-metadata.mjs` scans metadata and optionally applies a saved
  compare-and-swap repair. It is an operator tool, not an automatic startup task;
  inspect its target and report before any authorized `--apply` operation.
- [Documentation builders](../scripts/docs/README.md) generate ignored delivery artifacts.

## What belongs outside Git

`.next/`, `node_modules/`, generated `dist/`, `.release/`, `.deployment-backups/`,
`.load-tests/`, `output/`, credentials and local media are ignored. Do not delete
local backups, pending upload files or release evidence just to reduce checkout size.
They may be needed for recovery and are not shipped source. Test results, audit
reports, screenshots and benchmark outputs belong in these private directories,
not in `docs/` or beside test source. Keep test code and synthetic fixtures in Git.

## Removal standard

A zero-reference search identifies candidates, not proof of dead code. Check route
conventions, wildcard test discovery, dynamic paths, CSS, packaging and external
operator use. Required migration history and rollback tooling are not unused files.
Retired experiments and one-time scripts tied to obsolete local artifacts can be
removed; Git retains their earlier versions. Do not preserve a second copy in an
archive directory merely to keep dead code in the current tree.

## Client feature boundaries

- `components/gallery/` owns gallery response contracts, scoped mutation lifecycles,
  album/slideshow loading and photo metadata presentation. Shared media delivery and
  thumbnail batching remain in their existing modules.
- The shared destination-album controller retains each caller's explicit ordering
  and reset policy while owning request cancellation, editable filtering and
  cursor retry. Collection creation, folder actions, presentation and saved
  collection restoration have separate modules under `components/gallery/`.
- `components/access/` separates access requests and mutation lifetime handling
  from user-card presentation. The parent panel owns form and navigation state;
  all administrative writes use the shared bounded, validated controller.
- `components/activity/` owns identity-activity response contracts and request lifecycle.
- `components/use-gallery-status.ts` owns the lazily opened statistics request lifecycle;
  `components/gallery-stats.tsx` owns its presentation beside Search.
- `lib/identity/access-response.ts`, `lib/albums/sharing-response.ts`, `lib/costs/personal-cost-response.ts`
  and `lib/travel/travel-response.ts` validate feature-specific wire data before rendering.
  These do not replace server authorization or database policies.

Browser recovery checks mount actual components against synthetic local responses.
They prove navigation/error behavior, not native iPhone picker behavior or live permissions.

## Server feature boundaries

- `lib/search.ts` orchestrates authorization, candidate retrieval and hydration.
  `search-options.ts` validates request options, `search-semantic.ts` owns Cortex
  provider/partition calls, and `search-ranking.ts` owns pure rank fusion.
- `lib/people.ts` preserves its public API over owner-scoped queries, settings and
  correction transactions. `lib/search/` separates query construction, intent
  interpretation, retrieval/hydration and text search; current access remains
  required when saved IDs are hydrated.
- `lib/video/video-compression.ts` preserves the media API over process execution,
  transformations and stage/job orchestration in `lib/video/`. Process deadlines,
  codec arguments, publication fencing and original-file preservation remain
  responsibilities of those explicit layers.
- `lib/snowflake.ts` owns connection selection and pool lifetime. Its `snowflake/`
  directory isolates local connection configuration, secret retrieval, query
  execution/cancellation, and redacted logging. A named missing local connection
  fails instead of silently selecting another account. Storage-only requests still
  use their separate allowlisted pool and cannot fall back to a warehouse pool.
- `lib/access-management.ts` keeps the route-facing access API stable. Its
  `contracts` module validates requests; `authority` verifies current ownership and
  provider-specific grants; `commands` preserves Auth0/legacy Snowflake mutation
  ordering and catalog transaction ownership; `operations` owns the serialized,
  redacted durable journal and replay; `overview` assembles administrative reads.
  The current manifest selects PostgreSQL permissions and customer signup. The
  Snowflake authority path is still supported and tested, and last-admin enforcement
  stays in PostgreSQL.
