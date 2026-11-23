# Gateway replay protection and authorization cache invalidation

## Purpose and permissions

Adds a short-lived assertion ledger and a single authorization revision. The web login has no direct table permissions. Fixed SECURITY DEFINER functions expose only atomic assertion claiming, revision reads, and an increment gated by the transaction's verified access-manager identity. No token, subject, media URL, or credential is stored in the ledger. Expired identifiers are removed in bounded batches during authentication. Idle retained entries are harmless and removed on subsequent traffic.

## Rollout and compatibility

Apply using the migration runner after backup restore verification. Deploy the gateway first: it issues unique identifiers and request method/target claims accepted by both old and new applications. Deploy the app second to require binding and atomic consumption. Old authentication functions remain available for rollback. Privileged mutations bypass role caches; app-managed access changes increment the shared revision before and after external changes, including failures. Changes made directly in Snowflake retain bounded read-cache propagation; new privileged requests resolve current grants.

## Verification

Test duplicate and concurrent assertion claims, expiry, bounded cleanup, denied direct table access, and denied revision updates without access-manager context. Test method/path mismatches and repeated auth checks within a single request. Verify revocation and cross-instance epoch changes. Test gateway retries use fresh assertions. Verify signed-in render, API reads, writes, logout and permission guards after deployment.

## Rollback

Roll back the application first; the previous application ignores additional signed claims. Keep the additive migration and gateway deployed. Do not remove historical migrations or alter their hashes. This does not modify media or business records.
