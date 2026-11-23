# Historical setup and forward migrations

**Do not run this directory in order.** These files mix PostgreSQL, Snowflake,
security cutovers, rollback scripts, and superseded definitions. They record the
application's development history; they are not an idempotent fresh-install tool.

## Frozen baseline

`legacy-checksums.json` records SHA-256 hashes of the SQL and identity control code.
`npm run setup:check` rejects additions, removals, or edits to those historical files.
The release gate runs this check. Documentation can be updated separately.
This inventory proves repository consistency, not that every script was applied or
that production has no drift. The existing database baseline likewise inventories
legacy files without falsely marking them executed.

## PostgreSQL changes

1. Add `migrations/postgres/YYYYMMDDHHMM_description.sql` and matching `.md` notes.
2. Document compatibility with the currently deployed app, verification, and recovery.
3. Prefer additive changes. Keep destructive cleanup separate from a code rollout.
4. Run `python3 scripts/release/migrations.py check` to inspect pending/applied state.
5. Review the change, then use `python3 scripts/release/migrations.py apply`.
   The runner verifies a backup, uses a transaction and advisory lock, and records
   the checksum. Applied migration files must never be edited or deleted.
6. Run release checks and verify the changed behavior and access boundaries.

The PostgreSQL runner is not a Snowflake SQL runner. Do not point it at this directory.

## Snowflake changes

Use a new, separately reviewed forward-change file, with target account/database,
required role, prerequisites, expected grants, verification queries, and recovery
instructions. Snowflake DDL must not be treated as an atomic PostgreSQL transaction.
Save the deployed definitions and grants before a change and verify them afterward.
Never replay old grants simply because their script number is lower.

Application Service configuration belongs in the version-2 `app.yml`; manual service
configuration can be overwritten on the next declarative deployment. GPU worker
controls are separate from the web application release.

`workers/video-gpu/build-control.py` now renders the current worker specification into
the reviewed current control template **to stdout only**. Capture it as a proposed
forward change, review it, and verify grants before applying. It never edits migration
68 or runs SQL. See [GPU operations](../workers/video-gpu/OPERATIONS.md).

## Scope

This is a safe baseline and forward-change policy, not a claim that the legacy files
can provision a new account. A reproducible new-account installer and automated
Snowflake state reconciliation still require a separate inventory and validation.
See [Safe releases](../docs/SAFE-RELEASES.md).
