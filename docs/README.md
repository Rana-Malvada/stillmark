# Stillmark documentation

Current guides are checked against repository source; live state must be verified
separately. Keep run results and audit ledgers in ignored private evidence directories;
this index contains current instructions and design references.

## Reviewing this repository

Fifteen minutes: the [README](../README.md), then [architecture](ARCHITECTURE.md),
[catalog row-level security](CATALOG-RLS.md) and [safe releases](SAFE-RELEASES.md).

The [repository map](REPOSITORY-MAP.md) says where each responsibility lives.

## Start here

- [Architecture](ARCHITECTURE.md)
- [Development](DEVELOPMENT.md) and [contributing](../CONTRIBUTING.md)
- [Repository map and cleanup policy](REPOSITORY-MAP.md)
- [Testing and validation](TESTING.md)

## Operate and release

- [Production operations](PRODUCTION.md)
- [Rebuilding the system: what is and is not proven](REBUILD.md)
- [Safe releases](SAFE-RELEASES.md)
- [Deployment configuration](DEPLOYMENT-CONFIGURATION.md)
- [Snowflake automation authentication](SNOWFLAKE-AUTOMATION.md)
- [Stillmark application guide](APP-GUIDE.md)
- [Repository audit readiness](AUDIT-READINESS.md)

## Identity and security

- [Threat model and accepted risks](THREAT-MODEL.md)
- [Security policy and reporting](../SECURITY.md)
- [Runtime identities and permission boundaries](RUNTIME-IDENTITIES.md)
- [Application database row-level security](CATALOG-RLS.md)
- [Session revocation](SESSION-REVOCATION.md)
- [Automatic gateway token renewal](GATEWAY-TOKEN-RENEWAL.md)
- [Auth0 account lifecycle](AUTH0-PROVISIONING.md)
- [Auth0 customer accounts](CUSTOMER-ACCOUNTS.md)
- [Email alert connection](EMAIL-ALERTS-SETUP.md)
- [Gallery users: direct Snowflake login blocked](GALLERY-NETWORK-POLICY.md)
- [Gateway diagnostics](GATEWAY-DIAGNOSTICS.md)

## Uploads and background work

- [Queued upload processing](queued-upload-processing.md)
- [Upload staging in Snowflake-managed object storage](STAGE-UPLOADS.md)
- [Photo AI descriptions](AI-DESCRIPTIONS.md)
- [Upload concurrency controls](architecture/upload-admission-locking.md)
- [Dedicated upload pool lifecycle](architecture/upload-pool-lifecycle.md)

## Search

- [Natural-language search interpretation](SEARCH-INTERPRETATION.md)
- [Search admission and recovery](SEARCH-ADMISSION.md)
- [Search updates and recovery](operations/search-update.md)
- [Scoped search revision rollout](operations/scoped-search-rollout.md)

## Features and reporting

- [My travels](MY-TRAVELS.md)
- [Maps](MAPS.md)
- [Bulk album locations](ALBUM-LOCATIONS.md)
- [Albums, ownership and sharing](USER-ALBUMS.md)
- [User activity and identity reports](USER-ACTIVITY.md)
- [Cost attribution and chart](COST-ATTRIBUTION.md)
- [Personal and administrative cost reports](PERSONAL-COSTS.md)

## Independently released components

- [Cloudflare gateway](../cloudflare-gateway/README.md)
- [Upload worker](../workers/upload-cpu/README.md)
- [Face worker](../workers/face-cpu/README.md)
- [Search worker](../workers/search-cpu/README.md)
- [Video worker](../workers/video-gpu/README.md) and [operations](../workers/video-gpu/OPERATIONS.md)

## Design and verification instructions

- [Scaling program (objective, not a measured result)](architecture/million-user-scaling.md)
- [Target-state architecture design (partly built; status table inside)](architecture/stillmark-target-state.md)
- [Target-state security design (partly built)](security/stillmark-security-design.md)
- [Isolated load harness](../scripts/load-test/README.md) and [cloud generator](../scripts/load-test/cloud/README.md)
- [Document generation](../scripts/docs/README.md)
- [Immutable setup policy](../setup/README.md)
- [Public snapshot: how the clean public copy is produced](PUBLIC-SNAPSHOT.md)

Run `npm run docs:check` after documentation changes. It checks local file links and
that every Markdown guide under `docs/` can be reached from this index. It does not
verify external websites, deployed versions or the truth of prose.
