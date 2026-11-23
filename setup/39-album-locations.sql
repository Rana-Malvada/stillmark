-- PostgreSQL: reversible manual locations; original files are never modified.
BEGIN;
ALTER TABLE photos ADD COLUMN IF NOT EXISTS location_assignment_id uuid;
CREATE TABLE IF NOT EXISTS album_location_changes (
 id uuid PRIMARY KEY, event_id integer NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
 label text NOT NULL, latitude double precision NOT NULL, longitude double precision NOT NULL,
 applied_by text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now(), undone_at timestamptz
);
CREATE TABLE IF NOT EXISTS album_location_items (
 change_id uuid NOT NULL REFERENCES album_location_changes(id) ON DELETE CASCADE,
 photo_id integer NOT NULL, previous jsonb NOT NULL, PRIMARY KEY(change_id,photo_id)
);
CREATE TABLE IF NOT EXISTS travel_search_cache (
 query text PRIMARY KEY, results jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE travel_lookup_settings ADD COLUMN IF NOT EXISTS search_endpoint text NOT NULL DEFAULT 'https://nominatim.openstreetmap.org/search';
GRANT SELECT,INSERT,UPDATE,DELETE ON album_location_changes,album_location_items,travel_search_cache TO personal_photos_app;
COMMIT;
