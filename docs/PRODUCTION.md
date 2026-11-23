# Production operations

Source reviewed November 20, 2026. This is the current operating guide, not a live
inventory or a capacity guarantee. Store current measurements and release acceptance in ignored `.release/`.

## Identify what is running

The public site is `https://photos.stillmark.example`. The application service is
`PERSONAL_MEDIA.APP.PERSONAL_PHOTOS_APP`; names and destinations come from
[deployment.json](../config/deployment.json). Do not assume the newest Git commit
is deployed, or that an app release also updated the gateway and worker images.

Use the explicit production automation connection for authorized inspection:

```sh
snow sql -c stillmark-deploy -q 'DESCRIBE APPLICATION SERVICE PERSONAL_MEDIA.APP.PERSONAL_PHOTOS_APP'
snow sql -c stillmark-deploy -q "CALL SYSTEM$GET_APPLICATION_SERVICE_LOGS('PERSONAL_MEDIA.APP.PERSONAL_PHOTOS_APP')"
```

Compare the service version, deployed gateway version, worker image references and
private `.release/<release>/release.json` record. Public health checks do not prove
signed-in access isolation or that real uploads work. Record exactly which checks
were performed. Follow [safe releases](SAFE-RELEASES.md) for acceptance and rollback.

## Service boundaries

- The web app (Snowflake App Runtime) serves the app, permission checks, catalog reads and background coordination.
- PostgreSQL is authoritative for identities, permissions, metadata and durable jobs.
- The dedicated upload service receives chunks and processes accepted uploads.
- Separate finite CPU jobs handle faces and search enrichment; GPU jobs prepare video.
- Cortex provides AI inference and search. Stages hold original and derived media.
- Cloudflare handles public ingress, Auth0 sessions and authorized media delivery.

See [architecture](ARCHITECTURE.md) for the component diagram and code map.

## Incident triage

| Symptom                        | First evidence                                                          | Recovery boundary                                                                             |
| ------------------------------ | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Sign-in fails                  | Gateway logs, Auth0 result, app identity/session checks                 | Preserve issuer/subject and revocation checks; do not bypass authentication.                  |
| Thumbnails stall               | Failed browser request, response status/timing, gateway and media logs  | Compare network paths before changing routing or protocols. Capture failure before resetting. |
| Upload stays queued            | Upload job state/error, service readiness, pool state, lease timestamps | Accepted jobs belong to the server. Do not upload duplicates or clear active claims.          |
| AI is idle with pending photos | Coordinator/listener logs, claim/retry state, provider errors           | Notification wakes work; the one-minute recovery timer handles missed notifications.          |
| Search update stops            | Run chain, pipeline stage/error, root deadline, worker job status       | Automatic continuation is bounded by three hours; see the search runbook.                     |
| Video buffers                  | Preparation status, rendition availability, playlist/media responses    | AI analysis and playback preparation are separate; preserve originals.                        |
| Costs fail to load             | Saved report and refresh job state/error                                | Refresh is background work; do not start repeated warehouse queries from page loads.          |

Use [gateway diagnostics](GATEWAY-DIAGNOSTICS.md), [upload lifecycle](architecture/upload-pool-lifecycle.md),
[search update](operations/search-update.md), [AI descriptions](AI-DESCRIPTIONS.md),
[video operations](../workers/video-gpu/OPERATIONS.md), and [cost reports](PERSONAL-COSTS.md).

## Access, changes and recovery

Use `stillmark-test` only for the isolated test stack and `stillmark-deploy` for
production. A denied operation is not permission to switch to the human admin
connection. See [automation access](SNOWFLAKE-AUTOMATION.md).

Do not replay numbered `setup/` files, truncate queues, clear search state, enable
load generators, or restart active workers as a diagnostic shortcut. Inspect first;
use the existing bounded retry/recovery path and preserve durable state.

Configuration changes must survive the declarative deployment: update profile or
template sources and regenerate. Application, gateway and worker rollback must
remain compatible with the schema and session format.

Database backups do not contain stage media or external secrets. Restore scope,
worker release commands and required signed-in checks are documented in
[Safe releases](SAFE-RELEASES.md). This repository does not yet provide a verified
one-command installer for a new Snowflake account.

## PostgreSQL ingress maintenance

Keep database ingress limited to the published Snowflake platform ranges needed by
all services sharing this instance, plus explicitly approved operator sources.
Do not replace a failed connection with a blanket `0.0.0.0/0` rule. Published ranges
have validity periods: record their expiry privately, review the official network
range feed before expiry and after provider changes, and update only the relevant
rules while preserving other consumers and policy attachments.

Before changing a rule, save its current definition and rollback statement. After
an authorized update, verify fresh TLS connections from every dependent runtime,
not merely pooled sessions; check a known-disallowed source is rejected. Roll back
to the prior reviewed allowlist on failure rather than opening public ingress.
Keep assignments, timestamps and test outcomes in ignored `.release/`.

## PostgreSQL monitoring history

Use the [monitoring retention runbook](POSTGRES-MONITORING.md) for the daily raw-history purge, preserved query-history and aggregate retention, bounded recovery and rollback. This maintenance does not purge application data.
