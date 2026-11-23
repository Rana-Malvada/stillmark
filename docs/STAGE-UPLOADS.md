# Upload staging in Snowflake-managed object storage

New upload chunks are stored in the existing `PERSONAL_MEDIA.RAW.PHOTO_FILES` internal stage under `upload-chunks/`. No separate S3 bucket or credentials are required.

## Data flow

Browser → Cloudflare gateway → dedicated upload service → private stage chunks → queued worker assembly → permanent media objects and catalog metadata.

PostgreSQL stores ownership, progress, chunk locations, sizes, hashes and completion results. It no longer stores binary data for new upload chunks. Existing binary chunks remain readable until their sessions complete or expire.

The dedicated upload service carries the media traffic. Large videos are assembled on temporary worker disk, so worker disk capacity and transfer time remain limits. The web app handles UI, authorization, lifecycle coordination and status.

## Limits and recovery

- 4 GiB videos, 64 MiB images, 8 MiB chunks.
- Existing resumable-upload, authorization and replay behavior remains in place.
- Unique object paths prevent retried writes from overwriting another attempt.
- Downloads must match the saved byte count and SHA-256 before assembly.
- Completed chunks become eligible for background removal; cancellation and orphan cleanup are asynchronous, with a 24-hour initial cleanup delay.
- Referenced chunks are retained until their session metadata is removed. Cleanup work is bounded per maintenance pass.

## Deployment and verification

Stage-chunk schema is already part of the migration history. Do not replay `setup/34-stage-upload-chunks.sql`; use the migration runner for new changes. Retain compatibility with saved sessions when planning rollback.

Validate metadata-only writes, retries, legacy completion, integrity checks and cleanup protection. Exercise multipart reassembly and the supported large-file boundary in an isolated environment; record sizes, hashes and outcomes privately in `.release/`.

### Expired login during a long upload

The Cloudflare login session renews on successful gallery requests, with a
one-hour idle timeout and a fixed 12-hour maximum lifetime. Upload APIs may
return a plain-text 401 when that session expires. The client now reads HTTP
status before treating a response as successful JSON, retains partial uploads on
401/403, and pauses the queue after in-flight files settle. Sign in again in a
second tab of the same browser, then retry the failed files in the original tab.
Stable upload IDs let the server resume saved chunks or return an already
committed result without re-uploading it. Keep the original tab open if browser
storage reported that restart recovery was unavailable.

Transient gateway failures still retry; malformed successful responses are never
accepted as completed files. A zero-status XHR is rejected and retried instead of
leaving its promise unresolved. Session renewal does not bypass the 12-hour ceiling or logout revocation.
