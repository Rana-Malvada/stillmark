# Auth0 customer accounts

## Remembered sign-in

The gateway sign-in form offers a checked-by-default 30-day remembered session.
Unchecking it uses the one-hour idle and twelve-hour absolute limits. Remembered
sessions still undergo application authorization, account-state and revocation
checks; the option does not bypass logout or password-change invalidation. The
remembered-session migration must precede the matching gateway release so revoked
sessions remain recorded for the full lifetime. See [session revocation](SESSION-REVOCATION.md)
and [gateway session behavior](../cloudflare-gateway/README.md).

## Release status and activation

Customer account support and public signup are enabled. Auth0 handles registration,
verification and passwords; the application stores permissions and allowances in
Postgres. Existing customers retain their identities. GALLERYOWNER remains Admin.
No load testing is required for this rollout.

Three gates are deliberately independent:

| Gate                            | Location                                                               | Effect                                                                                                |
| ------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `CUSTOMER_ACCOUNTS_ENABLED`     | App manifest and gateway vars; upload worker `customerAccountsEnabled` | Enables customer bootstrap and credential-change checks                                               |
| `PUBLIC_SIGNUP_ENABLED`         | Gateway vars                                                           | Displays Create account and permits `/auth/signup`                                                    |
| `registration_settings.enabled` | Protected Postgres configuration                                       | Authorizes creation of new application accounts, including callbacks started before signup was closed |

Closing registration must set **both** the database gate and the gateway signup
switch false. Keep customer account support on: registered customers must still
sign in, and credential revocation must remain enforced. A signup URL is not an
access grant.

## Identity and permissions

Auth0 Universal Login owns passwords, signup, login, email verification, and recovery.
Cloudflare verifies the authorization-code response with PKCE, state, nonce, JWT
issuer/audience, and RS256 signature. The browser never supplies trusted role claims.
The verified callback invokes a short-lived, route-bound gateway assertion on
`POST /api/account/bootstrap`. This endpoint accepts no browser-provided profile body.

Postgres provisions the registry identity, permissions, and customer policy in one
transaction. Registration does not create a default folder or album; members create
their own after signing in. Callbacks are replay protected and idempotent for the same
identity. A registration lock serializes admission and enforces the rolling 24-hour
signup ceiling. New customers require verified email. Existing managed accounts retain
their previous verification behavior during this compatibility rollout.

New identities use a generated immutable registry UUID and internal `U_<uuid>` username.
The customer record binds the exact Auth0 issuer and subject. Email/name changes do
not change ownership, and accounts are never linked by matching email. Existing
managed accounts retain their names and UUIDs, including `GALLERYOWNER`; usage records
are not rewritten. New usage is attributed through the same internal username fields
used by upload, storage and AI cost accounting. Shared infrastructure costs retain
their existing allocation semantics.

The two assignable customer roles are **Member** (`member`) and **Admin**
(`administrator`). Member maps to existing personal-library capabilities. Admin maps
to full application administration, including all albums and access management.
`GALLERYOWNER` receives the Admin membership using its existing registry UUID; existing
memberships are retained. Legacy roles remain readable for compatibility; they are
not silently promoted or removed. When customer mode is enabled, the grant picker
presents the two customer roles. Infrastructure/service roles are unaffected.

Members see their own library, explicit shares, and albums marked `GALLERY` (shared
with all signed-in users, including future accounts). Private albums remain restricted
to their owner, administrators and explicit recipients. Both application and catalog
reader policies enforce these rules; photos inherit their parent album visibility. Face recognition stays opt-in through existing People settings.

## Passwords and recovery configuration

Use New Universal Login with the existing Auth0 database connection. Configure:

1. Password strength at least Good, with minimum length **14**. Verify that both signup
   and reset enforce the configured policy and display its requirements. Dictionary,
   personal-data, and breached-password controls are separate settings; only enable
   those available under the actual tenant entitlement.
2. Signup enabled for the intended application/database connection, email verification
   enabled, and the exact callback/logout URLs. Do not add wildcard redirects.
3. A production SMTP/email provider, a verified sender, and Stillmark verification/reset
   email templates. Auth0's built-in mail provider is for development testing.
4. Expiring reset links (recommend one hour), generic recovery responses, and the
   available Auth0 attack/rate protections. Stillmark does not implement a second
   password store or expose a public user-enumeration API.
5. Install `scripts/auth0/credential-change-action.cjs` as a **post-change-password**
   Action. Set `STILLMARK_ORIGIN`, `STILLMARK_ISSUER` (the login issuer, including its
   trailing slash), and a random 32-byte hex `STILLMARK_EVENT_KEY` in Action secrets.
   Store the same key as the gateway secret `AUTH0_EVENT_KEY`. Never put it in manifests,
   SQL, logs, Git, or browser JavaScript. Bind the Action to the password-change flow.

The Auth0 login issuer can be a custom domain; it is distinct from the Management API
hostname. For this deployment it comes from `deployment.AUTH0_DOMAIN`. The database
registration issuer and Action issuer must match that login issuer exactly.

The Action posts a signed, timestamped event to `/auth/credential-change`. The gateway
checks signature, issuer, body size and timestamp before forwarding a restricted
credential assertion. Postgres stores a monotonic cutoff per subject; older or
same-second sessions are rejected on subsequent app requests, including upload ingress.
A later fresh login works. A duplicate or old event cannot lower the cutoff.

**Delivery semantics:** Auth0's post-change Action is asynchronous and cannot roll
back a password change. It makes three bounded attempts. A gateway `200` acknowledges
confirmed Postgres persistence; `202` acknowledges an event committed to the existing
EmailAlerts Durable Object's separate `credential-events` instance. A bare success
status without the corresponding JSON acknowledgment is not accepted. Direct delivery
has a 2.5-second budget; a failed attempt is durably retained before acknowledgment.

### Durable credential recovery and failure alerts

The current tenant plan does not support custom log streams (the live API returned
HTTP 409). Recovery therefore uses the existing five-minute gateway cron to read
Auth0 logs by checkpoint. Provision a dedicated non-interactive Auth0 application
with **only** `client_credentials` and the Management API `read:logs` scope. Store
`AUTH0_LOG_CLIENT_ID` and `AUTH0_LOG_CLIENT_SECRET` as gateway secrets. The generated
manifest sets `AUTH0_LOG_POLL_ENABLED=true` and `AUTH0_LOG_TENANT_DOMAIN` to the
management tenant; event issuers still use the app's configured custom `AUTH0_DOMAIN`.
No broader user-management credential is copied to the gateway.

The existing `credential-events` Durable Object retains the checkpoint, starting
with the oldest retained log. Each run reads at most four pages (100 records each;
the initial bootstrap page contains one), caching its access token until near expiry.
This is a recovery capacity of at most 400 tenant log records per five minutes, not
an unlimited throughput claim. Only successful password changes (`scp`) enqueue
revocations; reset requests (`scpr`) do not. Every change must receive a durable
queue acknowledgment before its page checkpoint advances. Failed pages replay
idempotently, preserving original event timestamps. HTTP 429 responses back off.
No successful complete drain for 15 minutes makes recovery unhealthy. A gap exceeding
20 hours leaves a persistent coverage warning: retained provider logs may expire, so
later successful polling alone cannot prove there were no missed changes. An operator
must reconcile affected account cutoffs before clearing that private state warning.
See [Auth0 checkpoint semantics](https://auth0.com/docs/deploy-monitor/logs/retrieve-log-events-using-mgmt-api)
and [provider retention](https://auth0.com/docs/deploy-monitor/logs/log-data-retention).

An optional authenticated `POST /auth/credential-log` receiver remains available
for plans supporting streams and for scoped operator replay. Its separate random
32-byte hex `AUTH0_LOG_STREAM_TOKEN` also keys private delivery fingerprints. Never
reuse an Action key. The receiver accepts JSON arrays, raw records or wrapped log
envelopes, validating the full batch before enqueueing. Live receipts distinguish
`action`, `log-poll`, and `log-stream` without logging raw identities or credentials.

The durable queue coalesces by issuer/subject using the greatest original cutoff.
An alarm retries up to four accounts concurrently, with a 15-second delivery budget
and exponential backoff capped at five minutes. Failed events have no expiry and are
removed only after Postgres returns `{ok:true}`. Completed cutoff markers make duplicate
and older events harmless. At 1,000 pending accounts, new distinct accounts receive
`503` so the sender retains responsibility; accepted events are never discarded to
make room. No extra object lookup is added to normal app, upload, or media requests.

The existing five-minute email monitor checks the queue. A backlog older than one
minute is unhealthy; three failed checks trigger an incident and two successful
checks trigger recovery using the existing email sender. That check also restores a
missing queue alarm after a prolonged platform outage. Alarm/storage failures and
provider log recovery must be verified operationally; local tests alone do
not establish unattended delivery in the deployed tenant.

Revocation takes effect when Postgres persists the cutoff. During database outages,
customer authorization fails closed. After recovery, an asynchronous interval can
remain until retry persists the event. This queue is not a claim of immediate
password-change revocation while dependencies are unavailable. Older and same-second
sessions are rejected after persistence; later logins and other accounts remain valid.
Already downloaded media cannot be recalled.

After three failed Action attempts, the Action also emits a structured
`stillmark_credential_delivery_failed` record containing `version`, `issuer`, `subject`,
the original `changedAt`, and `attempts`. It excludes passwords, keys, signatures and
provider response bodies. Retain account identifiers only in restricted operational
evidence. Every rollout must record bound Action source, live log-reader permissions/checkpoints, durable retry,
alert/recovery delivery and the session matrix below before claiming it is verified.

For an authorized operator recovery:

1. Obtain the exact structured failure record and its Auth0 execution correlation.
   Verify the issuer, failed Action version, subject and original cutoff against the
   incident. Do not reconstruct `changedAt` from the current time or re-execute the
   Action: doing so can invalidate logins made after the original password change.
   An old generic failure without a trustworthy original cutoff requires incident
   investigation; this helper must not guess one.
2. Save only that JSON record to a private file outside the repository. Load
   `STILLMARK_ORIGIN` and `STILLMARK_ISSUER` from trusted configuration. Inspect the
   dry run with `node scripts/auth0/replay-credential-change.mjs --receipt PRIVATE_FILE`.
   It sends nothing and reports hashes instead of the raw subject. It needs no key.
3. Only with authorization to write to that environment, load `STILLMARK_EVENT_KEY`
   through the existing secret-handling mechanism and append `--send` to the same
   command. Never put the key in command arguments, shell history or the receipt.
   The helper makes one bounded request and retains the original cutoff; only the
   HMAC transport timestamp is renewed. An unknown outcome can be retried with the
   **same record** because PostgreSQL updates the cutoff monotonically.
4. Verify the old/same-second sessions are rejected, a session started after the
   original cutoff but before the replay still works, and another user's session
   still works. A successful HTTP acknowledgement alone is not this acceptance test.

Treat operational verification as **pending** unless every item below has captured
evidence from an authorized synthetic-account Auth0 run (prefer an isolated tenant).
Store each authorized provider drill and its limits privately in `.release/`.
A local test result or a configured rule alone cannot satisfy these requirements:

| Required evidence | Acceptance condition                                                                                                                                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Bound Action      | Read back the published source/version and matching trigger binding; compare the source hash to the tested revision.                                                                                                                                         |
| Failure           | Force delivery failure for a synthetic user; retain execution correlation and the original structured record after exactly three attempts.                                                                                                                   |
| Alert             | The existing monitoring destination actually receives an alert within the agreed incident-response window, with receipt/execution correlation, attempt count, original cutoff, owner and this runbook. Capture delivery and acknowledgement without secrets. |
| Replay            | Recover using the same original record; the acknowledged request retains its cutoff and uses a fresh transport timestamp.                                                                                                                                    |
| Session matrix    | Old and same-second sessions fail; a login between original cutoff and replay and a second user's existing session succeed. Repeat the same record and an older record without reducing the stored cutoff.                                                   |
| Cleanup           | Remove synthetic incident artifacts through the approved environment process; confirm no unrelated accounts or monitoring configuration changed.                                                                                                             |

Repeatable local checks are `node --test scripts/auth0/credential-recovery.test.mjs`
and `node scripts/auth0/verify-credential-recovery.mjs`. The latter uses the existing
disposable native PostgreSQL harness and intercepts every fetch; its alert sink is
in memory and sends no email. It tests the actual Action/gateway code and database
functions, with a synthetic adapter at the app HTTP/database boundary. It does not
exercise the deployed Next.js endpoint, live Auth0 runtime, inbox or external monitor.

Customer mode bypasses the gateway's thumbnail capability shortcut so each media
request reaches current Postgres session authorization. Existing object bytes may
still be cached, but the revoked session cannot obtain fresh authorization. This is a
security tradeoff to measure before restoring any edge authorization shortcut.

The avatar menu links to Account settings. Reset password goes to the hosted recovery
instructions; the actual Forgot password form and emailed reset page are Auth0-owned.

## Admission limits and account lifecycle

New customer upload and paid search allowances default to zero until configured.
Existing managed users are unaffected. Configure default budgets before inviting users;
otherwise a verified customer can sign in but must request an upload allowance.

The authorized deployment defaults are **1,000 upload admissions and 10 GiB** per new
account. Admins edit these in **Users & Roles → New account upload limits**. Saving
defaults affects only subsequently created accounts; existing usage, budgets,
registration switches and paid-search allowances stay unchanged. Both the API and
database functions enforce administrator access, and changes record old/new values
in the permission audit. Use **Set upload allowance** on a user's card for an
individual override. Zero requires an administrator to grant an allowance.

Upload admissions are reserved in the database when a new resumable upload session is
created. The row lock makes concurrent admission atomic. Each upload reserves one
admission and `total_chunks × 8 MiB` of lifetime transfer allowance, rounded up. This is
an **admission budget**, not a current-storage quota or dollar invoice. Failed/cancelled
uploads retain their reservation to bound abuse; a retry using the same upload ID does
not reserve twice. Admins can replenish total allowances using **Set upload allowance**
on the user's access card. The same control sets a separate paid search-interpretation
limit per UTC day. Ordinary text and semantic searches do not consume that limit.

Customer profile edits change display name only. Self-service email changes are not
implemented; request an administrator-reviewed Auth0 change. Deletion requests disable
the customer immediately, revoke their public share links, and prevent callback reactivation. An administrator must
complete media removal and login deletion; the page explicitly describes this workflow.
The existing managed-account deletion action alone preserves media, so it must not be
represented as completed media erasure. Admins cannot self-delete through this flow.

## Coordinated rollout

1. Apply the reviewed additive Postgres migration with the normal backup/restore release
   process. Leave registration disabled. Verify `GALLERYOWNER` resolves as enabled Admin
   with its original UUID and username; do not substitute a new account if it is missing.
2. Complete Auth0 password/email/Action configuration and capture test evidence without
   passwords, cookies, reset links, tokens or private media in the repository.
3. Configure the protected `photo_security.registration_settings` row through the
   authorized database administration connection: exact issuer, chosen default upload
   count/byte allowance, paid-search allowance, and daily signup ceiling. Keep enabled
   false until the final smoke checks. The web application has no direct table access.
4. Deploy app, gateway and upload worker with customer mode enabled together. The worker
   setting is `customerAccountsEnabled`; its renderer carries the flag into the service.
   A worker left in legacy mode would omit password-reset cutoff checks. Verify dedicated upload-service
   authentication before opening registration.
5. Test a fresh verified account and a second unrelated account; confirm legacy user
   access and `GALLERYOWNER` administration, email signup/reset, old-session rejection on
   pages/media/uploads, disabled-user denial, private albums, explicit shares, default
   face opt-out, usage attribution, allowance exhaustion, and deletion requests.
6. Enable database registration and the gateway Create account switch. Preserve these
   settings in the manifests/templates for future declarative deployments.

Rollback the signup switches first. Do not disable credential checks or revert the
private-album isolation while public customer accounts exist. No production or
Auth0 settings were changed merely by adding this code.

## Evidence and references

Local tests exercise transactional provisioning, replay, unchanged admin identity,
verified-email/issuer rejection, email non-linking, tenant RLS, private folders, grants,
allowances, reset cutoffs, deletion requests, gateway signatures and signup PKCE.
Live inbox delivery and the bound Auth0 Action require the coordinated smoke checks
above; unit tests are not evidence that those external settings have been installed.

- [Auth0 pricing and plan comparison](https://auth0.com/pricing)
- [Password policy configuration](https://auth0.com/docs/authenticate/database-connections/password-options)
- [Post-change-password Action semantics](https://auth0.com/docs/customize/actions/explore-triggers/post-change-password)
- [Production email configuration](https://auth0.com/docs/customize/email)

## Registration operation

Customer registration uses Auth0 database signup and the protected PostgreSQL
registration gate, controlled by `PUBLIC_SIGNUP_ENABLED`. Users & Roles manages
registered users and budgets; it does not create users in customer mode. Review
the current budget defaults and admission limits in configuration and database
settings before changing them. Preserve the existing owner identity and grants.

### Verification return flow

Unverified signup callbacks display “Check your email to finish creating your
account,” not an activation failure. Verified bootstrap failures use a separate
sign-in retry message. Neither screen offers another Create account button.

Auth0 rejected a custom verification `resultUrl` with its non-Enterprise entitlement
error. The application Default Login URI is set to the existing `/auth/start`
endpoint for Auth0's return-to-app control. The verification email also includes an
explicit return-to-Stillmark sign-in link while preserving its verification link.
Automatic redirection after verification is not promised on this tenant. Previously
sent emails are unchanged; after verification the user can return to Stillmark and
sign in. Verify the return flow with an authorized synthetic account after configuration changes.

### Signup error guidance

Auth0 English Universal Login signup and signup-password prompts use the
`auth0-users-validation` overrides in `scripts/auth0/signup-text-en.json` and
`scripts/auth0/signup-password-text-en.json`. These direct returning users to
Log in and Forgot password without asserting whether an address is registered.
The tenant generic signup response setting is unchanged. Read back overrides after applying them to verify the intended tenant configuration.

To apply an override, merge it with any existing prompt customizations before
using `auth0 api put prompts/<prompt>/custom-text/en --data @<file>`. The endpoint
replaces that prompt's customization object. No app rebuild is required.

### Account menu names

The menu and avatar render the registry display name, independently of the
immutable internal username used for permissions, ownership and cache isolation.
Account Settings refreshes this UI state after a display-name edit. Empty public
profiles show Member rather than their generated identifier.

The scoped post-login Action in `scripts/auth0/profile-name-action.cjs` uses
`STILLMARK_CLIENT_ID` to target this application and adds the signed ID-token
claim `https://stillmark.app/username`. Registration prefers this claim as the
initial display name. Existing profile edits are preserved on subsequent logins.

### Email sign-in and vanity names

The Auth0 database connection uses email/password sign-in with flexible
attributes: email is the only active login identifier. Its password policy, passkey options,
attack protection and signup settings remain intact. When changing this option
through the Management API, read the full options object first and preserve it:
patching `options` replaces that object rather than merging its fields.

Users choose their independent vanity name during signup and can edit it in
Account settings under Display name. Registration does not use an email address
as the default public name. Existing chosen display names remain
unchanged. Neither the email nor the vanity name replaces the internal ownership
identifier. The scoped profile Action preserves older signup usernames as initial
display names for accounts that already have one.

### Public authentication branding

Auth0's gateway application display name and tenant friendly name are Stillmark.
The signup and signup-password English prompt overrides use “Create your Stillmark
account” and “Your photos. Your memories. Your private library.” Existing error
guidance is preserved. These presentation settings do not rename the Snowflake
service, change the Auth0 client ID, or alter callback URLs.

### Required vanity name at signup

`signup-attributes.json` records the Auth0 connection attributes. Signup requires
email and a vanity name; only email is enabled as an identifier. The username
attribute is labeled Vanity name on signup screens and supplies the existing
scoped profile claim to Stillmark registration. It accepts 1–32 characters under
Auth0 username validation. Auth0 enforces uniqueness for this initial name.
Existing accounts without this attribute remain valid (`profile_required=false`);
their display names can be changed in Account settings without changing login.

The attributes replace legacy `requires_username` and `validation` options, which
Auth0 does not allow alongside flexible attributes. Preserve all unrelated options
when applying them. Email verification is enabled on the email signup attribute, using verification
links. Stillmark also requires a verified email before account activation.

Verified the live signup form shows Email address, Vanity name and Password, with
a required name field, while the login form shows Email address and Password only.

### Admin account labels

Users & Roles displays the vanity name and email without rendering internal
account IDs. Role prompts, account deletion confirmations and current-user audit
labels use the same human-readable identity. Delete confirmation asks for the
email (or DELETE if unavailable); the API still receives the immutable account ID
and marker, preserving existing authorization and operation retry behavior.
Profiles whose stored name is an internal ID or duplicates their email are labeled
Vanity name not set. Existing Member names remain visible until changed.

### Signup verification troubleshooting

Keep `attributes.email.signup.verification.active=true` when applying flexible
attributes. An unverified signup is not added to Stillmark's user registry until
the next successful, verified login. Auth0 account creation alone therefore does
not guarantee a user appears in the admin list.

Check Auth0 signup, verification, password-reset and login events together. A
completed password reset is evidence of that flow completing, not proof that an
earlier verification email reached the inbox. Inspect `fn` notification failures
and the configured provider's delivery logs for actual delivery problems.
