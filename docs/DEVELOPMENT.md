# Development

## Requirements

- Node.js 22, npm and the committed lockfile.
- Python 3 and a virtual environment for release tools (`requirements-dev.txt`).
- Git and Gitleaks for the release gate.
- Docker with already-pulled `postgres:17` and the pinned pgvector PostgreSQL 17 image
  named in `scripts/verification/local-postgres.mjs`, for native database tests. The
  database gate never pulls images itself.
- An installed Chrome-compatible browser for client recovery checks; use
  `CLIENT_TEST_BROWSER_PATH` when the default browser location is unavailable.

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run docs:check
```

Worker and gateway dependencies have their own manifests; consult their READMEs.
Do not replace lockfiles with unconstrained installs. The root postinstall applies
the documented [Snowflake SDK deadline patch](../scripts/snowflake-deadline/README.md).

## Configure before starting the app

Use an isolated development database and test resources. This is not a standalone
mock app: media, identity and provider features need their corresponding services.
There is no verified fresh-account bootstrap; do not run `setup/` in sequence.

Set explicit `PG_HOST`, `PG_PORT`, `PG_DATABASE`, `PG_USER`, `PG_PASSWORD` and TLS
configuration in ignored `.env.local`. For remote databases use verified TLS and
`PG_SSL_ROOT_CERT`; disable TLS only for an isolated local development database.
Set the database user explicitly. Do not rely on the code's fallback database user.

If `PG_HOST` is absent, [postgres.ts](../lib/postgres.ts) reads the local
`personal_media_pg` service, which may point to production. Inspect your own
configuration privately; never print or commit passwords. Explicit development
configuration prevents accidental use of that fallback.

Keep `BACKGROUND_JOBS_ENABLED` off locally unless intentionally testing workers in
an isolated environment. `DEV_AUTH=true` is development-only, grants a synthetic
identity, and does not simulate the full Auth0/gateway permission flow. Never use
it against production data or include it in a production deployment.

```sh
npm run dev
```

Use [deployment configuration](DEPLOYMENT-CONFIGURATION.md) for non-secret values
and generated manifests. Runtime secrets are mounted by Snowflake or provided by
private local configuration. Tests and builds do not justify granting admin access.

## Make and verify changes

Read the installed Next.js guides in `node_modules/next/dist/docs/` before changing
framework code. Follow existing shared components and data-access boundaries.
Add meaningful regression coverage for changed behavior and run the relevant
checks in [TESTING.md](TESTING.md).

- Format changed supported files with Prettier; check with `npm run format:check`.
- Lint with `npm run lint` ([oxlint](../.oxlintrc.json)). Correctness rules are errors.
  React Compiler readiness rules are warnings; clear them in files you touch.
- Feature switches are read only through [lib/flags.ts](../lib/flags.ts).
- Use Black for Python according to the repository configuration.
- Never rewrite applied SQL or the frozen setup baseline to fix a new issue.
- Never commit generated builds, credentials, private media, query outputs or backups.
- Commit and push completed work; deploying is a separate authorized action.

[Safe releases](SAFE-RELEASES.md) defines the full release process. Do not run a live
load test, paid AI acceptance test or deployment as a routine local test.
