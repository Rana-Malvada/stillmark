# Contributing

## Before you start

Read the [architecture guide](docs/ARCHITECTURE.md), the
[repository map](docs/REPOSITORY-MAP.md) and the [development guide](docs/DEVELOPMENT.md).
Use Node.js 22 (`.nvmrc`) and an isolated development database; copy `.env.example`
to `.env.local`.

## Making a change

1. Work on a branch. Keep a change to one purpose.
2. Run the local checks:

   ```sh
   npm run check          # type check, lint and unit tests
   npm run format:check
   npm run docs:check     # after documentation changes
   ```

3. Add or update tests for behaviour you change. Tests that touch permissions should
   run real SQL under row-level security, as `tests/app-rls.test.ts` does.
4. Open a pull request. CI runs a quick job (types, lint, formatting, unit tests) and
   the full release gate.

## Rules that are easy to miss

- **Authorization.** The album read rule has one definition: `albumReadSql` in
  `lib/albums/album-sql.ts` and `canReadAlbum` in `lib/albums/album-access.ts`. Do not write it out
  again; add a visibility mode in those two places and in the row-level security
  policy migration.
- **Database changes** are forward-only migrations under `migrations/postgres/` with a
  paired note. Never edit an applied migration or anything under `setup/`.
- **Generated files.** `app.yml` and worker production specifications are rendered from
  `config/deployment.json` and `config/templates/`; edit the inputs.
- **Advisory review bindings.** Files listed in `config/package-advisory-reviews.json`
  are bound to the worker image security reviews. Changing one fails the release gate
  until the owner re-confirms the reviews. Say so in the pull request.
- **Secrets** never go in the repository, in logs or in test fixtures. The release gate
  scans history for them.
- **Shared edge modules.** `lib/*.mjs` files are imported by the Cloudflare gateway;
  changing one needs a coordinated app and gateway release.

## Commit messages

Use a conventional prefix (`fix:`, `feat:`, `refactor:`, `perf:`, `docs:`, `chore:`,
`test:`), an imperative subject, and a body that says why.

## Releases

Releases are run by the owner. See [safe releases](docs/SAFE-RELEASES.md).
