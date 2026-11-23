# Legacy gallery users: direct Snowflake login policy

Current customer accounts use Auth0 and PostgreSQL, without individual Snowflake
users. See [customer accounts](CUSTOMER-ACCOUNTS.md). This policy applies only to
retained legacy Snowflake-backed gallery identities.

## Policy boundary

`PERSONAL_PHOTOS_NO_DIRECT_LOGIN` blocks direct IPv4 and IPv6 ingress for legacy
gallery users. Never attach that block-all policy to the account, owner
administrator or gateway transport identity. Verify actual assignments and
exceptions before a change; keep the inventory and rollback SQL privately.

The gateway authenticates to Snowflake using its transport identity and forwards
a signed individual identity. Legacy users must remain enabled for application
identity resolution. This network policy does not change album roles, sharing or
read-only restrictions, and does not immediately terminate every existing session.

## Provisioning and recovery

The legacy provisioning path sets the network policy in `CREATE USER` and reapplies
it when recovering interrupted provisioning. Missing policy or missing privilege
fails closed. Customer-mode signup does not use this per-user Snowflake path.
Numbered setup files remain immutable history; use forward migrations for changes.

To remove a policy for a specifically authorized legacy identity, first record its
current assignment and prepare rollback. An administrator can use
`ALTER USER <username> UNSET NETWORK_POLICY`; never apply this broadly as a login
workaround. Recheck direct-login denial, gallery access and policy exceptions after
any change. Store execution evidence in ignored `.release/`.
