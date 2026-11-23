# Auth0 account lifecycle

Production customer registration uses Auth0 for authentication and PostgreSQL for
application identities, roles and allowances. Registering a customer does not
create a Snowflake user. The gateway's Snowflake transport identity is separate
from the person using the application.

## Registration and administration

Users register through Create account, verify their email, and sign in with email.
Display names are presentation data, not authorization identifiers. The application
uses the verified Auth0 issuer and subject to establish the account; matching an
email address alone must not link identities or transfer library ownership.

Users & Roles manages access, roles, upload allowances and deletion. Password resets
use Auth0's Forgot password flow. GALLERYOWNER retains its administrator identity.
The current configuration, signup gates, verification flow, password-change Action,
and account deletion behavior are documented in [Customer accounts](CUSTOMER-ACCOUNTS.md).
Use that document as the configuration reference rather than historical setup scripts.

## Credentials and verification

Auth0 Management API credentials are mounted secrets. Never commit credentials,
passwords, tokens, verification links or provider response bodies. Application
checks must scope administrative operations even when a provider credential has
broader tenant-level permissions.

Verify a fresh account, email verification, reset delivery, old-session rejection,
private-library isolation, explicit sharing, disabled-user denial and retryable
account deletion before changing identity configuration. Tests must not reset a
real user's password or adopt another account based on an email match.

Historical Snowflake/SAML provisioning migrations remain immutable recovery records.
They are not instructions for current customer signup. See
[runtime identities](RUNTIME-IDENTITIES.md) and [safe releases](SAFE-RELEASES.md).
