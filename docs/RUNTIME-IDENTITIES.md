# Runtime identities and permission boundaries

Source reviewed November 20, 2026. Actual grants must be inspected before an
administrative change; this is not a claim that live grants have been audited.

| Component                    | Identity / boundary                                          | Responsibility                                                      |
| ---------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------- |
| Public user                  | Auth0 issuer and subject, application user in PostgreSQL     | Sign in without an individual Snowflake account.                    |
| Cloudflare ingress           | `PERSONAL_PHOTOS_GATEWAY` / `PERSONAL_PHOTOS_GATEWAY_ACCESS` | Authenticate transport to the app; sign the user assertion.         |
| Application Service          | `PERSONAL_PHOTOS_RUNTIME`                                    | Runtime Snowflake operations, separate from account administration. |
| Catalog access               | `personal_photos_app`, transaction-scoped context and RLS    | Enforce authenticated user/share permissions on catalog operations. |
| Maintenance and upload queue | Separate mounted PostgreSQL credentials                      | Bounded service work; not a substitute for caller authorization.    |
| Worker jobs                  | Dedicated worker owner roles and scoped database access      | Face, search, upload and video processing.                          |
| Routine production releases  | `STILLMARK_AUTOMATION`, `stillmark-deploy` connection        | Authorized app and worker release operations.                       |
| Human administrator          | Explicit administrative handoff                              | Account/resource/grant changes outside automation scope.            |

Names and secret bindings are in [the profile](../config/deployment.json),
[app manifest](../app.yml), and worker specifications. Secret values never belong
in the repository. See [automation grants](SNOWFLAKE-AUTOMATION.md) for exact scope.

## Authorization

[database-context.ts](../lib/database/database-context.ts) establishes transaction-local
identity; [CATALOG-RLS.md](CATALOG-RLS.md) documents database enforcement.
Application checks remain required before privileged service operations. A shared
connection pool must not retain another caller's identity between transactions.
Postgres administrator access must not be used as an app runtime fallback.

Customer registration uses Auth0 and PostgreSQL, not per-user Snowflake provisioning.
Role changes, account state and session revocation affect access; see
[customer accounts](CUSTOMER-ACCOUNTS.md) and [session revocation](SESSION-REVOCATION.md).
Existing account-usage reporting privileges can expose account-level usage to the
runtime. They should not be described as restricted to one customer's gallery.

## Releases and recovery

Use the existing service and explicit automation connection. Do not create a
replacement under ACCOUNTADMIN, grant broad privileges to bypass a denial, or
resume the retired administrator-owned application. Current recovery uses a
compatible prior app version and coordinated gateway/worker configuration, as
specified in [Safe releases](SAFE-RELEASES.md).

The September identity cutover and its old service-switch rollback are preserved
in Git history; they are not current operating instructions. Applied migrations
remain immutable. New permissions require a reviewed forward migration and tests
for authorized access, denied cross-owner access and pooled-connection isolation.
