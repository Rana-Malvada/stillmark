# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately to the repository owner through
GitHub (a direct message to the owning organisation's administrator, or a request for
a private channel in an issue that contains no details). Do not describe the problem
in a public issue, and do not include private media, credentials or share links in a
report.

Include what you observed, the steps to reproduce it, and the account role you used.
You will get an acknowledgement, and a fix or a written decision once it has been
assessed. Please allow time for a fix before disclosing publicly.

## Scope

In scope: the web application, the Cloudflare gateway, the worker images and the
release tooling in this repository.

Out of scope: denial of service by volume, findings that need a compromised
administrator account or device, and the third-party platforms themselves
(Snowflake, Cloudflare, Auth0), which have their own reporting programs.

## What to read first

- [Threat model](docs/THREAT-MODEL.md): assets, adversaries, controls and accepted risks.
- [Catalog row-level security](docs/CATALOG-RLS.md) and
  [runtime identities](docs/RUNTIME-IDENTITIES.md): what the database enforces and
  which credential can do what.
- [Session revocation](docs/SESSION-REVOCATION.md).
- [Safe releases](docs/SAFE-RELEASES.md): release gates, image scanning and how
  unfixed advisories are reviewed.
