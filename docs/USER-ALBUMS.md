# Albums, ownership and sharing

PostgreSQL stores album ownership, explicit sharing, visibility and folder membership.
Authentication establishes a stable application identity; display names and email
addresses are presentation values, not permission keys.

## User behavior

- A customer creates private albums in folders they choose or create.
- My Albums is a navigation page, not an automatic folder.
- Explicit album invitations grant the documented viewer access.
- An album's owner can share it with every signed-in gallery user, and make it
  private again, from Album access. The main admin can do the same for any album.
  Other administrators cannot change the visibility of albums they do not own.
- Administrator access is capability-based; it does not change the album's owner.
- Account deletion preserves retained media under the original owner in the
  admin-only Deleted accounts area. Re-registering with the same email does not
  automatically adopt a deleted identity or its library.

## Enforcement

Application checks and PostgreSQL row-level security enforce the current caller's
rights. Search results and media requests must remain permission-scoped. Public share
links are separate capabilities with expiry and revocation, and can cover a whole
album or a selected subset. Previously downloaded copies cannot be recalled.

Trash and catalog changes enqueue search removals or updates as appropriate. Removing
a file from Trash does not acknowledge its removal from the semantic index; search
publication must still process that removal.

See [Customer accounts](CUSTOMER-ACCOUNTS.md), [catalog RLS](CATALOG-RLS.md),
[session revocation](SESSION-REVOCATION.md) and [production operations](PRODUCTION.md).
Applied ownership migrations are immutable records; use the migration runner for new
schema changes instead of replaying historical setup scripts.
