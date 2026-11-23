# Snowflake automation authentication

Initially configured October 25, 2026; later grant changes are dated below. Routine local Snowflake CLI work
uses the service user `STILLMARK_AUTOMATION` and RSA key-pair authentication,
without browser SSO or MFA prompts. This does not automate the Snowsight UI.

## Connections

| Connection         | Active role                   | Default namespace                 | Purpose                                                                       |
| ------------------ | ----------------------------- | --------------------------------- | ----------------------------------------------------------------------------- |
| `stillmark-test`   | `STILLMARK_TEST_AUTOMATION`   | `STILLMARK_LOADTEST_BASELINE.APP` | Isolated test apps, workers, image builds, and pool sizing                    |
| `stillmark-deploy` | `STILLMARK_DEPLOY_AUTOMATION` | `PERSONAL_MEDIA.APP`              | Authorized production app builds, deployment, and existing runtime operations |

Both connections disable secondary roles and leave the warehouse unset. They
belong to the same user, so selecting the test connection is an operational
scope guard, not a security boundary against someone holding its private key.
The user's default role is the test role. The global CLI default is unchanged.

```sh
snow sql -c stillmark-test -q 'SELECT CURRENT_USER(), CURRENT_ROLE(), CURRENT_WAREHOUSE()'
snow sql -c stillmark-test -q 'SHOW SERVICE INSTANCES IN SERVICE STILLMARK_LOADTEST_BASELINE.APP.UPLOAD_WORKER'
snow sql -c stillmark-deploy -q 'DESCRIBE APPLICATION SERVICE PERSONAL_MEDIA.APP.PERSONAL_PHOTOS_APP'
```

When deployment is authorized, use the existing checked release workflow:

```sh
python3 scripts/release/deploy.py --connection stillmark-deploy --deploy
```

The manifest and its template put remote builds in the project APP schema and
use a dedicated `PERSONAL_PHOTOS_APP_AUTOMATION_CODE` source stage. This avoids
depending on a human user's personal database or replacing their source stage.
Builds still incur their normal compute cost. The deployment role requires
APP-schema `CREATE APPLICATION SERVICE`, the application's existing owning role
and artifact repository ownership. Check the latest private release record for
what is deployed. If permissions drift, review
`scripts/release/grant-deploy-schema-permission.sql` with an authorized
administrator rather than silently changing identities or reapplying grants.

## Permissions and boundaries

- The test role inherits the existing isolated runtime role, with image
  repository READ/WRITE and MONITOR/OPERATE/MODIFY on the two isolated test pools.
- The deployment role inherits `PERSONAL_PHOTOS_RUNTIME`, with the production
  build integration, APP-schema CREATE APPLICATION SERVICE/CREATE SERVICE/CREATE STAGE/CREATE SECRET, and image
  repository READ/WRITE.
- Publishing packages requires artifact repository OWNERSHIP; Snowflake has
  no separate artifact WRITE privilege. Ownership of
  `PERSONAL_MEDIA.APP.PERSONAL_PHOTOS_REPO` moved from `ACCOUNTADMIN` to the
  deployment role with `COPY CURRENT GRANTS`. The application service's owner
  and runtime role did not change.
- Both automation roles are granted upward to `SYSADMIN` for administration.
  The service user does **not** receive SYSADMIN, SECURITYADMIN, or ACCOUNTADMIN.
- Existing runtime privileges include project secrets/data, Cortex access,
  warehouse USAGE, and some Snowflake account usage/security monitoring. This
  is a privileged project automation identity, not a read-only identity.
- Creating users, changing authentication/network policies, provisioning new
  account-level resources, and operations on objects not granted to these
  roles may still need human administrator authentication. Do not broaden
  privileges automatically when a command is denied.
- Existing scripts that default to `exampleadmin` are not globally rewritten;
  pass the appropriate connection explicitly where supported. Review scripts
  that provision account resources before switching their authentication.

## Production worker releases without browser login

On November 8, 2026 (November 9 UTC), the user authorized the deployment service
account to perform routine app and worker releases without a human login. The
administrator granted the existing `PERSONAL_PHOTOS_UPLOAD_WORKER` and
`PERSONAL_PHOTOS_FACE_WORKER` roles to `STILLMARK_DEPLOY_AUTOMATION`, plus
`CREATE PROCEDURE` on `PERSONAL_MEDIA.APP` to the face-worker role. Reproducible
setup is in `scripts/release/grant-worker-release-permissions.sql`.

These are existing project runtime owner roles, not grants limited to two objects.
They include their stage access, scoped secret access and job ownership. The upload
role also has `BIND SERVICE ENDPOINT` and `MONITOR USER`. No administrator role,
network-policy privilege or new credential was granted. At that time the face-launcher role, which also owns search controls, was not added.
On November 14, 2026, the user authorized completing the remaining project worker
release access. The existing VIDEO_WORKER, VIDEO_LAUNCHER, FACE_LAUNCHER and
SEARCH_WORKER roles (all prefixed PERSONAL_PHOTOS_) were granted to
STILLMARK_DEPLOY_AUTOMATION, with APP-schema CREATE PROCEDURE granted to those
four owner roles. The same reproducible grant script includes these grants.
This permits existing video/search job and launcher maintenance without a browser
login; it does not grant ACCOUNTADMIN or unrestricted account administration.
For JavaScript procedures place COPY GRANTS after the argument list, before RETURNS.

Use `snow ... -c stillmark-deploy` to inspect and update the existing upload
service. For a reviewed `FACE_JOB_CONTROL` replacement, keep the existing owner
as the primary role using `--role PERSONAL_PHOTOS_FACE_WORKER`, and use
`CREATE OR REPLACE PROCEDURE ... COPY GRANTS`. Pass
`--enable-templating NONE` when executing procedure SQL so the CLI preserves
JavaScript ampersands. Verify the stored body, ownership and caller grants after
replacement. Do not run the full provisioning scripts for an image-only release.

The app still uses the checked release command above; `npm run release` also
selects `stillmark-deploy` explicitly. The global CLI default and historical
provisioning connection remain unchanged. PostgreSQL backup and
migration tools use the separately configured `personal_media_pg` libpq service;
the Snowflake CLI connection does not select their database identity. Operations
outside these grants still require an explicit scope review rather than silently
falling back to the administrator.

## Unattended isolated test operations

The test role additionally has:

- `OPERATE` and `MODIFY` on `STILLMARK_LOADTEST_BASELINE_PG`, allowing
  description, resume/suspend and isolated instance configuration changes.
  MODIFY was explicitly authorized on October 28 for PgBouncer tuning; the
  Snowflake privilege also permits other configuration changes on this one
  instance. It does not grant production access or ownership.
- `MODIFY PROGRAMMATIC AUTHENTICATION METHODS` on
  `STILLMARK_LOADTEST_BASELINE_GATEWAY_USER` and
  `STILLMARK_LOADTEST_BASELINE_U1`, allowing test PAT creation and revocation.
  This Snowflake privilege also covers programmatic authentication methods
  beyond PATs; it is scoped to those two identities only.

Use `stillmark-test` for these operations rather than the human admin connection.
Keep issued tokens in private, mode-0600 files and provision gateway secrets
through the isolated gateway configuration. Gateway media PATs must use
`STILLMARK_LOADTEST_BASELINE_GATEWAY_ROLE`; the U1 generator controller uses
`STILLMARK_LOADTEST_BASELINE_PERSONAL_PHOTOS_VIEWER`. Verify a real image returns
`X-Media-Delivery: storage` before load; HTTP 200 alone can hide a signing failure
behind the app fallback. These grants do not authorize
account-wide user creation, new resource provisioning, production permission
changes, or unrestricted administration. Production deployment uses the separate
deployment role and requires user authorization.

Reproducible grants are in
`scripts/load-test/grant-automation-operations.sql`. The script requires an
administrator only for the initial grant or restoration of a revoked grant.

## Credential and network controls

The private key is stored only on this Mac at
`~/.snowflake/keys/stillmark_automation.p8`. It is an unencrypted RSA-3072 key
with mode `0600`, in a directory with mode `0700`, to allow unattended CLI use.
Anyone able to read that file can use the identity from an allowed network.
Never copy it into the repository, chat, build context, or deployment bundle.
The CLI connection file stores the key path, not its contents.

`PERSONAL_MEDIA.IDENTITY.STILLMARK_AUTOMATION_KEYPAIR` permits only KEYPAIR
authentication. `STILLMARK_AUTOMATION_LOCAL` restricts this user to the single
public IPv4 address observed during setup. Other users' policies are unchanged.
If the home public IP changes or the Mac moves to another network, an admin
must update that policy after verifying the new address. Do not replace it
with an allow-all policy to work around a login failure.

For emergency revocation, an administrator can run:

```sql
ALTER USER STILLMARK_AUTOMATION SET DISABLED = TRUE;
```

For planned rotation, generate a new private key locally, attach its public
key as `RSA_PUBLIC_KEY_2`, update and verify both local connections, then remove
the old public key and securely retire its private file. Never overwrite the
only working key before verifying the replacement.

To reverse the repository ownership change, an administrator can transfer it
back while preserving grants:

```sql
GRANT OWNERSHIP ON ARTIFACT REPOSITORY PERSONAL_MEDIA.APP.PERSONAL_PHOTOS_REPO
  TO ROLE ACCOUNTADMIN COPY CURRENT GRANTS;
```

## Verification checklist

Check fresh key-pair connections for both explicit roles, no selected warehouse,
empty secondary roles, intended object grants and denial of administrator-role
selection. Verify user authentication/network policies and private-key filesystem
permissions. Save outcomes and deployed-state snapshots privately in `.release/`.

References: [key-pair authentication](https://docs.snowflake.com/en/user-guide/key-pair-auth),
[CLI connection configuration](https://docs.snowflake.com/en/developer-guide/snowflake-cli/connecting/configure-connections),
[artifact privileges](https://docs.snowflake.com/en/user-guide/security-access-control-privileges),
[build location](https://docs.snowflake.com/en/developer-guide/snowflake-app-runtime/app-yml).

On October 30, 2026, the user authorized adding CREATE SECRET on PERSONAL_MEDIA.APP
to STILLMARK_DEPLOY_AUTOMATION. The service account created MEDIA_GRANT_SIGNING and
granted READ to PERSONAL_PHOTOS_RUNTIME. This allows app-schema secret provisioning
without a personal admin login; no account-wide administration role was granted.
