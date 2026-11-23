# Repository audit and evidence policy

## Review boundaries

Review the exact source commit, generated configuration and deployed artifact identities separately.
A passing unit suite does not establish live permissions, provider availability, throughput or complete semantic coverage.
Keep the current audit ledger, findings, measurements and release acceptance record in ignored `.release/`.
Record each check's source, environment, scope, outcome and remaining limitations there.

## Reviewer entry points

1. Read the [architecture](ARCHITECTURE.md) and [repository map](REPOSITORY-MAP.md).
2. Compare [production operations](PRODUCTION.md), manifests and worker settings with the private release record.
3. Inspect [runtime identities](RUNTIME-IDENTITIES.md), [RLS](CATALOG-RLS.md) and [session revocation](SESSION-REVOCATION.md), with their migrations and regression tests.
4. Run the checks described in [testing](TESTING.md) and [safe releases](SAFE-RELEASES.md).
5. Verify signed-in owner, shared, unrelated, read-only and administrator workflows against the deployed artifacts. Record unchecked provider or device behavior explicitly.

## What belongs in Git

Keep application and worker source, regression tests and synthetic fixtures, lockfiles, forward migrations, configuration, current operating instructions and architecture designs.
Applied migration files and numbered setup files are immutable lineage, even when their statements describe retired infrastructure.

Do not commit test results, audit finding reports, logs, screenshots, benchmark outputs, deployment receipts or generated document exports.
Store those privately in `.release/`, `.load-tests/` or `output/` as appropriate. Preserve useful evidence when cleaning the checkout; do not rewrite Git history as part of routine cleanup.
Design diagrams are source illustrations, not test screenshots. Dependency inventories and applicability policies used as build inputs remain version controlled.

## Verification and publication

Run `npm run docs:check`, `npm run config:check`, `npm run setup:check`, `npm run typecheck`, `npm test`, `npm run test:load-harness` and `npm run format:check` as appropriate to the change; use the complete release gate for application changes.
The load-harness command tests the harness locally; it does not generate live traffic.

A private history scan can be recorded without printing secret values:

```sh
gitleaks git --redact --report-format json --report-path .release/secret-scan.json
```

A scan does not certify public-release readiness. Review personal identifiers and account metadata separately. Revoke a discovered credential before planning any history rewrite.
