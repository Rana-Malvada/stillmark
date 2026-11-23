# Customer registration and isolation

Additive migration for Auth0-only customer signup, applied through the normal migration
runner after backup verification. Defaults are closed registration and zero customer
admission budgets. Existing registry usernames and ownership/cost history are retained.
The known `GALLERYOWNER` registry identity receives Admin without creating a replacement.

The only existing authorization behavior narrowed is implicit GALLERY visibility for
accounts explicitly marked `registration_source='public'`. Existing managed identities
retain collection access. New helper functions use fixed search paths and restricted
EXECUTE privileges. Authority/configuration tables have RLS and no direct app grants.

See [customer account operations](../../docs/CUSTOMER-ACCOUNTS.md) for coordinated app,
gateway, worker, email and reset Action activation. Do not revert RLS or cutoff checks
while public accounts exist. Closing registration does not disable established accounts.

Validation: `tests/customer-accounts-postgres.test.ts`, gateway customer-account tests,
existing permission, replay, RLS and Auth0 management suites. This migration does not
create Snowflake users or select/start a Snowflake warehouse.
