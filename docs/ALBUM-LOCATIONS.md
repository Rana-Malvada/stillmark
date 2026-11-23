# Bulk album locations

Album owners and the app owner can choose **Set missing locations**, search a public place name, select a match, confirm its map position, and apply it. Read-only administrators cannot use the mutation endpoints, including with combined roles.

Only READY media with both latitude and longitude null and no manual assignment are eligible. Partial coordinates, GPS locations, and previously assigned locations are preserved. The count is rechecked transactionally when applying, so concurrent uploads may change the final total. Originals in object storage are untouched.

PostgreSQL stores location_assignment_id on each photo and keeps the actor, time, selected place and previous geographic metadata in album_location_changes/items. The photo viewer labels these locations as manual and approximate. My Travels reads updated coordinates immediately. Existing updated_at triggers queue the changed photos for search publication, which runs automatically when automatic processing is enabled (Sync Search remains a manual recovery action); this feature never calls AI or search itself.

Undo remains available on the album after reload. It restores prior geographic metadata only for photos still in that album with that assignment and matching assigned coordinates/place. Moved, removed or subsequently reassigned photos are not modified. Changes and snapshots cascade when an album is deleted.

Search uses the existing Nominatim integration. Explicit button submits only (no autocomplete or bulk provider calls), five results maximum, 30-day PostgreSQL result cache, the shared global advisory lock and two-second cooldown with reverse lookup, eight-second timeout, one-hour backoff on provider 403/429, identifying User-Agent, and visible OpenStreetMap attribution/policy link. Administrators can disable lookups or change travel_lookup_settings.search_endpoint. The lookup request contains the entered public place name, not photos or account identifiers.

Migration: setup/39-album-locations.sql. Application runtime role needs the grants in that migration.
