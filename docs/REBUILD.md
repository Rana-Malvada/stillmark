# Rebuilding the system

There is no single command that stands up Stillmark in an empty account. This page
states what can be rebuilt today, how, and how well each path is proven, so the gap
is explicit instead of implied.

| Part                         | How it is rebuilt                                                                                                                                                                       | How well proven                                                                                                                                                      |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Application code             | `python3 scripts/release/deploy.py --connection <connection> --deploy` from a clean checkout                                                                                            | Run on every release                                                                                                                                                 |
| Gateway                      | `npm run deploy` in `cloudflare-gateway/`, after setting its secrets                                                                                                                    | Run on every gateway release                                                                                                                                         |
| Worker images                | Built, tested and scanned by `scripts/release/check_worker_images.py`, then published and pinned                                                                                        | Run on every release; publication steps are in each worker's README                                                                                                  |
| Database contents and schema | Restore the latest verified backup into PostgreSQL 17                                                                                                                                   | A full restore into a fresh database is performed and checked by the release gate on every release                                                                   |
| Database schema only         | The schema snapshot `tests/fixtures/rls-schema.sql`, then forward migrations in `migrations/postgres/`                                                                                  | Partly: tests and the native database gate build from the snapshot plus a selected migration set                                                                     |
| Generated configuration      | `npm run config:render` from `config/deployment.json` and `config/templates/`                                                                                                           | Drift is checked on every release (`npm run config:check`)                                                                                                           |
| Snowflake account objects    | Provisioning SQL beside each worker (`workers/*/provision.sql`; the upload service's is rendered by `workers/upload-cpu/render.mjs`) and the forward changes in `migrations/snowflake/` | **Not proven end to end.** Each file was applied once, by hand, to the existing account                                                                              |
| Media                        | Snowflake internal stages; not part of database backups. Deleted files are retained by a Snowflake file-management feature the owner has enabled on the account                         | Configured in Snowflake, outside this repository: it neither manages nor checks that feature. `scripts/recovery/media_manifest.py` lists what a restore must contain |

## What a new environment needs

1. **A deployment profile.** Copy `config/deployment.json`, change every name, host and
   identifier, and render. The profile holds no credentials.
2. **Snowflake objects.** A database and schemas, the roles described in
   [runtime identities](RUNTIME-IDENTITIES.md), an image repository, stages for
   originals and derived files, compute pools for upload, face, search and video,
   secrets for the PostgreSQL credentials and gateway signing key, network rules and
   external access integrations, and the control procedures rendered by each
   worker's `build-control.py`. The provisioning SQL files create these; review them
   against the profile before running anything.
3. **PostgreSQL.** A Snowflake Postgres instance with the application, maintenance,
   upload-queue and worker roles. Restore a backup, or load the schema snapshot and
   apply migrations with `python3 scripts/release/migrations.py apply`.
4. **Auth0.** A tenant, the gateway application and the actions described in
   [Auth0 provisioning](AUTH0-PROVISIONING.md) and
   [customer accounts](CUSTOMER-ACCOUNTS.md).
5. **Cloudflare.** The Worker, its custom domain, and its secrets: session and
   signing keys, the Auth0 client secret and log credentials, the Snowflake renewal
   key, and the alert mailbox login, sender and recipient.

## What `setup/` is

`setup/` is the frozen record of how the first environment was changed over time. It
mixes PostgreSQL and Snowflake statements, cutovers and rollbacks, and must not be run
in order. See the [setup policy](../setup/README.md).

## Closing the gap

A proven from-scratch path needs two things that do not exist yet: one reviewed
Snowflake provisioning script generated from the deployment profile, and a scheduled
job that builds an isolated environment from it and runs the release checks there.
The isolated load-test environment (`stillmark-test` in
[Snowflake automation](SNOWFLAKE-AUTOMATION.md)) is the nearest thing today: it was
built by hand from the same sources.
