# Search batch finalization schema access

## Compatibility

Additive permission fix for existing search workers. The travel-summary migration
already grants EXECUTE on photo_security.refresh_travel_summary(), but omitted
USAGE on its schema. Workers therefore fail after enrichment before marking the
batch completed, preventing the publishing/ranking continuation. No worker or app
restart is required. Completed enrichment is retained.

## Verification

The local travel-summary verification first reproduces SQLSTATE 42501 as the
search-worker role, applies this migration, and executes the real summary builder.
It verifies that the role still cannot create schema objects or directly read
photos. Existing concurrency and rollback checks remain in place. Production
verification checks effective schema and function privileges after application.

## Rollback

REVOKE USAGE ON SCHEMA photo_security FROM personal_photos_search_worker;
This restores the previous failure; prefer fixing forward. No data changes.
