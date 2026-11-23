# Optional shared native authorization cache

Creates only a private cache table, expiry index and two narrow security-definer
functions. The app role cannot access the table directly. The application accepts
only HMAC-verified envelopes bound to the exact caller token/context/epoch digest,
with an original expiry no more than 60 seconds away. No credentials are stored.

The feature is off unless all intended replicas receive the same random 32-byte
`NATIVE_ROLE_CACHE_SIGNING_KEY` encoded as 64 lowercase hexadecimal characters.
Provision it through secret configuration, never in a committed manifest. Apply
the schema before enabling it. Validate the complete authority chain in isolation
before enabling this cache in a deployed environment.

Disabling the environment setting restores local-only caching. To remove the
schema later, first disable it on every replica, then drop the two functions and
`photo_security.role_cache`. No user/media data or role grants are changed.
Cache access failures fall back to live authorization; they never authorize a
request. Admin mutations and access-manager checks continue to verify live grants.
