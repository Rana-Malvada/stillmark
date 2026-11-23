# Postgres application permission authority

Additive migration for the opt-in `APP_PERMISSION_AUTHORITY=postgres` authentication path. The default remains `snowflake`. This migration does not grant any existing user access and does not change production configuration.

## Data and request flow

`photo_security.app_principals` binds account status and revision to the registry UUID, not a reusable username. `app_roles` defines canonical access profiles; `app_memberships` assigns profiles or managed groups. Permission changes append an idempotent audit entry atomically with the membership/status change.

Each verified gateway request resolves the linked registry identity, assertion replay claim, logout status, current permissions, and main-admin designation in one database statement on the primary. No cross-request permission cache is used in this mode. Revocation applies to the next request after commit; a request already authorized may finish. Existing tenant/album row-level policies remain in force.

Native end-user Snowflake ingress is rejected in this mode. Auth0 authenticates the user through the signed gateway; the gateway Snowflake identity continues to authenticate infrastructure transport. Creating app users does not create Snowflake users. The existing Auth0 management integration remains responsible for identity lifecycle.

## Activation prerequisites

1. Back up the database and validate the migration and recovery process in isolation.
2. Import an explicitly reviewed permission snapshot, mapping existing registry markers and effective roles to canonical profiles. Include custom groups, account enabled state, and app owners. Missing principals or memberships deny access.
3. Verify all intended users have correctly linked Auth0 subjects and at least one enabled app owner exists. Resolve unregistered/native-only users before enabling this mode.
4. Enable the flag only in the intended deployment manifest. Exercise unauthorized access, role reduction, account disable, logout, administrator revocation, and cross-user data isolation through the actual gateway.
5. Compare sustained mixed browsing/upload traffic against the same capacity and latency gates.

The isolated load-test fixture grants exactly the existing 500 synthetic users `viewer`, plus separate app-only integration identities. That fixture is not a production import procedure.

## Administrative integrity

Permission mutations recheck the actor's current authority inside the database, serialize rare administrative writes, protect owner/access-manager roles, reject self changes, retain an active owner, and audit idempotent operations. Registry deletion cascades memberships; recreating a username with a new UUID does not inherit old grants. Application credentials cannot directly read or write the authority tables. SECURITY DEFINER functions use a fixed search path and restricted EXECUTE grants.

## Rollback

Do not automatically fall back to Snowflake on a database error or invalid configuration. Flipping the authority back to Snowflake can reactivate old grants or disabled accounts unless both authorities have been reconciled. A rollback therefore requires a reviewed permission reconciliation before changing the flag. Retaining the additive tables is safe with the legacy flag; destructive rollback is unnecessary.
