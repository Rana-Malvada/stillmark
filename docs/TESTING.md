# Testing and validation

Choose tests by the changed boundary. A mocked API test is not proof of a real
upload, browser layout, PostgreSQL race or production capacity.

| Check                                   | Command                                   | Boundary                                  |
| --------------------------------------- | ----------------------------------------- | ----------------------------------------- |
| Documentation links and index coverage  | `npm run docs:check`                      | Repository files only                     |
| Generated configuration drift           | `npm run config:check`                    | Local, read-only                          |
| Historical setup checksums              | `npm run setup:check`                     | Local, immutable baseline                 |
| TypeScript                              | `npm run typecheck`                       | Local type checking                       |
| Lint                                    | `npm run lint`                            | Unused code and likely mistakes           |
| App regression suite                    | `npm test`                                | Vitest; opt-in integration cases may skip |
| Component rendering tests               | `npx vitest run tests/components`         | jsdom, mocked `fetch`; runs in `npm test` |
| Gateway regression suite                | `npm --prefix cloudflare-gateway test`    | Gateway-specific tests                    |
| Real client recovery                    | `npm run test:client-recovery`            | Installed browser, synthetic fixtures     |
| Native database and restore correctness | `npm run test:database-gate`              | Disposable local PostgreSQL containers    |
| Load harness unit tests                 | `npm run test:load-harness`               | Local harness logic, not a live load test |
| Production build and local smoke        | `npm run build` then `npm run test:smoke` | Built app, local boundary tests           |
| Complete release gate                   | `npm run release:check`                   | Aggregates checks, audits and build       |

[scripts/release/check.py](../scripts/release/check.py) is authoritative for the
release gate. Run plainly, or on GitHub, it runs everything; a release reuses a hosted
pass on identical files for the source-only checks (see
[Safe releases](SAFE-RELEASES.md)). [check_database.py](../scripts/release/check_database.py) enumerates
native PostgreSQL checks, including AI notification recovery, search deletion,
search continuation/deadline, account authority and admission races. It refuses an
implicit image pull and records source fingerprints and results in `.release/`.

## Tests that are not ordinary local checks

- `test:search-acceptance` can make paid model calls when its opt-in requirements are met.
- `migrations:check` and `backup:verify` access configured databases; review targets first.
- `release:postcheck` checks the live public endpoint.
- Load generators require explicitly isolated resources and authorization. Running
  harness unit tests does not establish thousands-of-users capacity.
- Real signed-in acceptance requires actual accounts, media and permission boundaries.
  Record untested cases instead of marking a release fully accepted.

See [safe releases](SAFE-RELEASES.md) for backup/restore and release procedures and
the [load harness](../scripts/load-test/README.md) for isolation. Keep all execution
results, screenshots and audit ledgers in ignored `.release/` or `.load-tests/`,
never in the source tree. Do not carry an old test count forward to a new commit.
