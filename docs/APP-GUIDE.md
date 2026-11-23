# Stillmark application guide

This guide describes the current source workflows. Deployment settings and release
verification are recorded in [Production operations](PRODUCTION.md).

## Accounts and libraries

Users create accounts through Auth0, verify their email, and sign in with email.
A display name identifies them in the interface. Password reset uses Forgot password.
Administrators manage access and allowances in Users & Roles; customers do not need
individual Snowflake users. See [Customer accounts](CUSTOMER-ACCOUNTS.md). Optional “keep me logged in” lasts
30 days; ordinary sessions retain the shorter idle/absolute limits. Logout and
account revocation still apply.

Collection separates personal albums, the shared collection, and administrative
views of other owners. My Albums is a navigation page, not an automatically created
folder. Choose an existing folder or create one in the upload form. New personal
albums are private unless their access settings are changed.

## Uploads

The browser sends resumable chunks through the gateway to the dedicated upload
service. PostgreSQL records ownership, accepted chunks, queue state and results;
Snowflake internal stages hold the media. Accepted files process on the upload CPU
pool independently of the browser. Files not yet transferred still need the browser
and original local files.

The panel distinguishes transferring, queued, processing, completed and failed files.
Recovery uses stable upload IDs and saved results to avoid duplicate publication.
Use the error details and retry controls for failures. Reselect local files after
reopening if the browser no longer holds them. Missing dates or GPS do not mean the
original file was lost. See [Queued processing](queued-upload-processing.md).

Opening Upload requests worker startup. After fifteen idle minutes without admitted
transfers or queued/processing jobs, the controller suspends the service and pool.
An open completed dialog does not extend that timer. Limits and implementation are
in `lib/upload/upload-limits.ts` and [the lifecycle runbook](architecture/upload-pool-lifecycle.md).

## Viewing, sharing and organizing

Albums support photo/video viewing, selection, favorites, metadata editing and Trash,
subject to the caller's permissions. Shared links can expose a whole album or a
selected subset. Their expiry, revocation, downloads, location and people-name
options control what the recipient can access. Downloaded copies cannot be recalled.

Deleted-account content stays in the admin-only Deleted accounts area under its
original owner; deleting an account does not transfer its library to the administrator.
See [Album ownership](USER-ALBUMS.md).

## People and places

Face scanning starts automatically for new uploads when the owner enables People;
administrators retain progress and recovery controls.
Users review and assign identities or ignore detections. The photo viewer can show
face highlights and ignored detections. Group review offers Select all for the
faces on the current page, not unseen pages. Search uses confirmed and automatic
person associations, excluding suggestions; see the search interpretation guide.

My travels uses saved location information and GPS. Place-name lookup and map display
are separate from manually editing an album's location. Maps use CARTO Positron when
configured. See [My travels](MY-TRAVELS.md) and [album locations](ALBUM-LOCATIONS.md).

## AI and search

Photo descriptions run automatically after successful publication. Production uses
direct Cortex REST; `lib/ai-categorize.ts` defines the model and prompt. Basic search
uses catalog text and metadata; semantic retrieval and optional intent interpretation
are separate paths. Access checks apply to returned results.

When automatic processing is enabled, catalog changes are queued for automatic search
publication. Sync Search remains an explicit recovery action for pending revisions and
removals. Update Search performs
OCR, visual enrichment and saved-ranking work, with its configured follow-up sequence.
Update Search continues eligible batches automatically within a single three-hour
deadline. See [search operations](operations/search-update.md).
Those operations are different: completing enrichment does not by itself prove that
every catalog revision has reached the search service. Inspect stage status and errors.
See [Search interpretation](SEARCH-INTERPRETATION.md) and the search worker runbook.

## Batch activity

With automatic processing enabled, new uploads schedule face scanning, playback preparation
and OCR/search work. AI video descriptions remain manual. Activity shows progress, failures
and recovery controls; routine Start commands are no longer needed. Workers reuse their
processes for 15 minutes after work, without stopping active jobs. Search cycles have a
three-hour deadline. Jobs retain durable state after the page closes. Review failed items
and retry state rather than treating an elapsed timer as completion.

- [Face worker](../workers/face-cpu/README.md)
- [Video worker](../workers/video-gpu/README.md)
- [Search worker](../workers/search-cpu/README.md)

## Costs

Cost-page reads use cached usage data. Administrators explicitly refresh provider
usage; ordinary users cannot trigger that refresh. Refresh work is persisted and
continues after leaving the page; other devices read the saved report. Reports use Eastern dates and
show estimates, not invoices. Production hosting and PostgreSQL estimates are
allocated by membership time, including partial days; test resources are excluded.
Upload, face/search and GPU pool usage have their own categories. Provider reporting
can lag and unavailable amounts must not be represented as a measured zero.
See [Personal costs](PERSONAL-COSTS.md) and [attribution](COST-ATTRIBUTION.md).

## Operations

Use [Safe releases](SAFE-RELEASES.md) for deployment, migrations and recovery.
Do not replay numbered setup scripts. App, gateway and worker releases are distinct;
changing source or a manifest is not proof that every deployed component changed.
