# Instructions for coding agents

Code in this repository is written by AI coding agents under the owner's direction.
Nothing is trusted because an agent wrote it; these rules and the release gates are
the control. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow.

## Before a change reaches `main`

- Run `npm run check`, `npm run format:check` and, after documentation changes,
  `npm run docs:check`. The release gate and CI run the same checks and more.
- Files listed in `config/package-advisory-reviews.json` are bound to the worker image
  security reviews. Changing one requires the owner's explicit sign-off for that
  specific change before the review record is updated. Never update the record on
  your own authority.
- Never commit secrets, credentials, generated build output, test results or private
  temporary artifacts. Add files by name; do not add a directory that may contain a
  linked `node_modules`.
- A deployment, a database migration and a worker image release each need the owner's
  explicit go-ahead. A request to hold deployment does not mean hold the Git push.

## GitHub synchronization

Commit and push completed, verified changes as part of every task; collect a task's
commits on a branch and merge to `main` once, because every push to `main` starts the
full check. Verify the push succeeded and report any blocker.

# Snowflake App Runtime

## Local automation authentication

Use `snow ... -c stillmark-test` for the isolated load-test environment and
`snow ... -c stillmark-deploy` for authorized production operations. These use
the `STILLMARK_AUTOMATION` service user with a local key pair; no browser login
is needed. Pass the connection explicitly (including
`python3 scripts/release/deploy.py --connection stillmark-deploy --deploy` for
an authorized release). Do not silently fall back to the personal admin
connection when a permission is missing. See
`docs/SNOWFLAKE-AUTOMATION.md` for scope, credential handling, and recovery.

The global CLI default and historical provisioning connection remain unchanged.
Account administration still uses the human admin connection when necessary.

Routine production upload and face-worker image releases are also authorized
through `stillmark-deploy`; its role inherits the existing worker owner roles.
Replace `FACE_JOB_CONTROL` with `--role PERSONAL_PHOTOS_FACE_WORKER` and
`COPY GRANTS` to preserve its execution owner. Use `--enable-templating NONE`
for procedure SQL. See `docs/SNOWFLAKE-AUTOMATION.md` for the exact grant scope.

This project deploys as an Application Service on Snowflake via `snow app deploy`.

## Key APPLICATION SERVICE Commands

| Command                                                                      | Description                            |
| ---------------------------------------------------------------------------- | -------------------------------------- |
| `DESCRIBE APPLICATION SERVICE <name>`                                        | View service details and configuration |
| `SHOW APPLICATION SERVICES`                                                  | List all deployed application services |
| `ALTER APPLICATION SERVICE <name> SUSPEND`                                   | Pause the service                      |
| `ALTER APPLICATION SERVICE <name> RESUME`                                    | Resume a suspended service             |
| `ALTER APPLICATION SERVICE <name> UPGRADE`                                   | Upgrade to a new version               |
| `CALL SYSTEM$GET_APPLICATION_SERVICE_LOGS('<database>.<schema>.<app_name>')` | Retrieve service logs                  |
| `GRANT USAGE ON APPLICATION SERVICE <name> TO ROLE <role>`                   | Grant access to roles                  |

## Key CLI Commands

- `snow app deploy` — Deploy or update the application service
- `snow app events` — Stream deployment events and logs
- `snow app open` — Open the deployed app in your browser
- `snow app teardown --force` — Remove the deployed service

## Project Structure

This Next.js project configures its build and runtime in `app.yml`. Where the _deployment_ configuration lives depends on the manifest layout: if `app.yml` has a top-level `version: 2` it holds both, and any `snowflake.yml` is ignored; otherwise `snowflake.yml` holds the deployment configuration and `app.yml` is build-only. The app runs on HTTPS and is accessible via the generated Application Service endpoint in Snowflake.

Note that a `version: 2` deploy applies the manifest declaratively, so `ALTER APPLICATION SERVICE ... SET` changes are reverted on the next deploy unless they are also in `app.yml`.

## Next Steps

For complete reference on building, developing, deploying, and operating Snowflake Apps, invoke the **snowflake-apps** skill.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
