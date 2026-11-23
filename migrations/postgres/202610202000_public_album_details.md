# Shared album details

Adds opt-in location and people permissions per public link. Existing links default
to false. Old app versions remain compatible because both columns have defaults.
The new app requires this migration before deployment.

The restricted public_photo_people function validates the current capability hash,
expiration, revocation, album membership and current ownership. It returns only
settled, visible names and normalized boxes, including manual name-only tags.
It does not broaden face-table RLS or expose person IDs, embeddings or crop paths.
Per-link permission is explicit and independent of signed-in name-sharing settings.

Verify defaults with information_schema.columns and run the public-album-details
security tests. Apply using scripts/release/migrations.py apply before deployment.
Location filtering happens in the details endpoint via an explicit field allowlist;
raw metadata, internal paths and private annotations are never returned. Original
media downloads may retain embedded GPS independently of the details setting.
