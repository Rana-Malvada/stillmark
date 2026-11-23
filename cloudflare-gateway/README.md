# Stillmark gateway

Cloudflare Worker for `photos.stillmark.example`. It authenticates through Auth0,
forwards signed user identity to the Snowflake application, and delivers authorized
media from Snowflake stage storage. `wrangler.jsonc` and the Worker source define the
current configuration; secrets are managed outside Git.

## Authentication and sessions

The application verifies gateway assertions and maps identities to managed gallery
users. A shared Snowflake ingress credential is not the visitor's identity.
The gateway strips untrusted identity headers and restricts the upstream origin. Each assertion has a unique ID, binds its HTTP method and path/query, expires within 30 seconds, and is atomically consumed in PostgreSQL. Repeated authorization checks within one request share that claim; retries receive new assertions.

Sessions use Secure, HttpOnly cookies. Eligible gallery activity renews the idle
window (one hour idle, twelve hours absolute); passive polling does not extend it.
The sign-in form also offers a checked-by-default 30-day remembered login. Its
expiry is fixed at sign-in and is not extended by activity. Apply
`migrations/postgres/202611180900_remembered_sessions.sql` before releasing this
gateway so logout revocations cover the entire remembered lifetime.
Production session revocation uses PostgreSQL through the application. Logout
commits revocation before reporting success. Already-authorized streams can finish.
See [session revocation](../docs/SESSION-REVOCATION.md) for the boundary.

The gateway PAT rotates through the private token store; old static-secret bootstrap
instructions are obsolete. See [token renewal](../docs/GATEWAY-TOKEN-RENEWAL.md).
Never print or commit PATs, signing keys, session keys, or client secrets.

## Rate limits

Sign-in routes (`/auth/*`) are limited to 30 requests a minute per client address
and public share routes to 600, using Cloudflare's rate limiting binding declared in
`wrangler.jsonc`. An exceeded limit returns 429 with `Retry-After`. The limiter
fails open: if the binding is missing or errors, the request proceeds, because
sign-in must not depend on it. These ceilings bound cost and guessing; sessions and
256-bit share tokens remain the controls that protect data. See
[rate-limit.mjs](rate-limit.mjs).

## Media delivery

Every new media request receives a live application permission check, including
album shares and revocation. Approved storage URLs are internal to the gateway and
may be cached separately from authorization. Stage responses preserve byte ranges
and stream without resizing or transcoding. Private browser responses are not
shared-cacheable. Catalog thumbnails may be stored in the browser with mandatory
revalidation (`private, no-cache, max-age=0, must-revalidate`). Every reuse still checks
the current session and album access before forwarding an ETag to storage; unchanged
bytes return 304. Downloads, display images, videos, public shares and errors remain
`no-store`. No offline or fresh-cache permission bypass is introduced. Signing/storage failures use the application's authorized fallback.

The original and derived stages have separate permissions. Changes to image quality,
video conversion, or rendition selection belong to the application/worker, not this
transport layer. Inspect `MEDIA_DELIVERY_MODE` and the route code for current behavior.

## Public map tiles

The configured CARTO Positron path fetches tiles directly in the browser and is not
proxied by this Worker. The OSM path below is the fallback. See [maps](../docs/MY-TRAVELS.md).

Authenticated map requests use a dedicated edge path for public OpenStreetMap cartography. This path forwards no gallery credentials, uses an identifying User-Agent, respects upstream cache headers and validators, and uses a seven-day fallback only if freshness headers are absent. Cloudflare's edge cache and the browser reuse tiles. Errors, private responses and no-store responses are not cached. Media caching is separate: only authorized thumbnail responses permit mandatory browser revalidation as described above. Attribution remains visible in the map.

## Diagnostics

`GATEWAY_METRICS` binds `personal_photos_gateway_metrics`. Diagnostics are sampled
and capped, with safe fields rather than credentials, full URLs, or user content.
See [diagnostics](../docs/GATEWAY-DIAGNOSTICS.md) for schema and verification queries.
Dataset existence alone does not prove records are being written.

## Development and release

From this directory:

```sh
npm ci
npm test
npm run typecheck
npm run check
```

`typecheck` type checks every gateway module (not the tests) with the TypeScript
installed at the repository root, so run `npm ci` there first. The Worker's `env`
shape and the Cloudflare runtime types it relies on are declared once in
[types.d.mts](types.d.mts); see [tsconfig.json](tsconfig.json) for the settings.

`check` performs a Wrangler dry run. A gateway deployment is separate from the
Snowflake app release. Review bindings, secrets, allowed origins, and routes before
`npm run deploy`; preserve the previous version for recovery. Verify login/logout,
private access, expiring shares, upload chunks, and media range requests afterward.

The root release gate runs gateway tests and production dependency audits but does
not deploy the Worker. Avoid attributing an app-only release to gateway changes.

`MEDIA_EDGE_TIMEOUT_MS` bounds the combined URL-signing and initial storage
response wait before the normal authorized app fallback (default 5000 ms;
100–10000 ms). Keep this shorter than the caller deadline to leave fallback time.
It does not limit a healthy video response body after headers have arrived.
Canceled callers do not initiate fallback requests.
