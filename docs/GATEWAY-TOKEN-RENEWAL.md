# Automatic gateway token renewal

## Gateway network policy

The gateway transport identity uses the user-level Cloudflare ingress policy.
Its network rules allow Cloudflare's shared address ranges, not a unique Worker;
credential and role restrictions remain required. Fetch current published ranges
when updating this policy, preserve the account policy and administrator access,
and test both the application endpoint and SQL API renewal route. Keep the applied
SQL, rollback and observed assignments in `.release/`.

The Auth0 management access token already renews on demand. This automation manages the separate 30-day Snowflake PAT used by Cloudflare to reach the gallery.

## Operation

- Cloudflare's existing Worker runs an hourly scheduled check at minute 17 UTC.
- One private SQLite-backed Durable Object coordinates renewal and stores the active credential encrypted with a key derived from the Worker SESSION_KEY secret.
- Renew when seven days or less remain. The first authenticated request bootstraps the first renewal.
- A dedicated RSA key for PERSONAL_PHOTOS_GATEWAY signs a short-lived JWT to Snowflake's SQL API. The private key remains a Cloudflare secret.
- PERSONAL_PHOTOS_TOKEN_RENEWAL has MODIFY PROGRAMMATIC AUTHENTICATION METHODS only on PERSONAL_PHOTOS_GATEWAY. It has no warehouse, table, or account-administrator grants. The gateway PAT remains restricted to PERSONAL_PHOTOS_GATEWAY_ACCESS, which has no credential-management privilege.
- Rotation preserves the old token for 24 hours. The new token must pass the app's health endpoint before it becomes active. Worker isolates cache a token for five minutes.
- Pending token material and the SQL request ID are persisted before activation, so retries reuse the same rotation result. No token is returned by a public route or logged.

A failure preserves the last active credential. Hourly retries continue. A prolonged outage beyond expiry can still interrupt service; automation is not a guarantee against provider outages or revoked keys. Check Cloudflare scheduled-event failures and the sanitized `gateway_token_renewal_failed` log. Successful logs contain only the new expiration date.

## Cost

The hourly check normally reads only Cloudflare storage. Snowflake is called when rotation is due: ALTER USER, SHOW token metadata and one application health request. No warehouse is selected or used. Cloud-services accounting may still apply under Snowflake's account billing rules; do not promise absolute zero billing. Cloudflare Workers/Durable Objects usage is subject to the account's plan and limits; this small workload is intended to fit free allowances.

## Operations and recovery

Keep the Durable Object binding/migration in wrangler.jsonc. It contains the current token; the original SNOWFLAKE_PAT bootstrap secret was removed after the first successful renewal. Do not roll back to an older Worker that reads only that secret after the overlap window.

Do not rotate SESSION_KEY without migrating/re-encrypting the token store (and any pending token). This key also protects user sessions. RSA key rotation remains an administrative maintenance operation; use Snowflake's second key slot for overlap, update the corresponding Cloudflare private key and fingerprint, verify renewal, then remove the old key.

To pause scheduled rotation, remove the cron trigger while retaining the active token store. To restore the old static-token design, first securely install a fresh valid role-restricted PAT into SNOWFLAKE_PAT, then remove the binding in the Worker implementation. Never delete the store as a troubleshooting shortcut.

Setup grants: setup/32-gateway-token-renewal.sql. Implementation: cloudflare-gateway/token-renewal.mjs. Tests cover encryption, activation, failure preservation, request-ID reuse, concurrent checks, expired-token behavior and health validation.

## Deployment verification

Verify rotation under the restricted role, no query warehouse, successful health
validation before activation, overlap with the old token and normal signed-in
media requests. Preserve exact receipts privately in `.release/`; do not force
routine production rotation merely to refresh a historical test result.
