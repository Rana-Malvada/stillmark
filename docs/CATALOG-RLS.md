# Application database row-level security

## Enforced production boundary

The runtime uses verified request identity for application queries. The current
tables and grants are defined by forward migrations. Policies preserve ownership,
explicit album sharing, GALLERY
visibility, administrator capabilities and read-only restrictions. Missing identity
returns no user data. Existing application authorization remains active as a second
check. Legacy folder membership can remain during unrelated album edits, but new
assignments must target an authorized folder.

Identity and capability flags are transaction-local. Authentication is resolved
before checking out a connection, and each database transaction clears its identity
on commit/rollback. Failed rollback destroys the connection. Request-scoped auth
coalescing does not cache authorization between requests. Public routes use the
hashed share token; policies check expiry, revocation and current album ownership.

Fixed security-definer functions provide narrow login/revocation lookups and queue
counts. They have a fixed search path and no PUBLIC execution permission. Trigger
functions preserve search queues and activity summaries without granting clients
access to global maintenance tables.

## Trusted maintenance

Background processing and verified global cost/place operations explicitly use
personal_photos_maintenance with its separate mounted secret. It has scoped table
grants, no BYPASSRLS and no identity-administration update grant. The web login has
no membership in this role and never falls back to it when authentication fails.
The GPU worker has its own separately restricted grants.

The runtime is trusted to establish verified identity and protect both credentials.
This protects against omitted row filters and accidental unscoped requests; it is
not a boundary against arbitrary execution inside a compromised application server.

## Migration policy and validation

The original rollout used setup/72a-rls-provision.sql and setup/72-app-rls.sql.
These are frozen historical files; do not replay them. Use the current
[forward migration process](SAFE-RELEASES.md). Do not roll back to an older runtime without
first planning compatible database policies; old unscoped queries fail closed.

Execute the actual migration SQL against an isolated current-schema copy. Cover
cross-user reads/writes, share expiry and revocation, maintenance role separation,
triggers and connection reuse. Validate signed-in production workflows separately
after an authorized release. Keep results in ignored `.release/`.
