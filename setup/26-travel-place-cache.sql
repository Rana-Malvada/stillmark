-- Postgres only. Public geographic labels, not user or album records.
CREATE TABLE IF NOT EXISTS travel_place_cache (
 area_id text PRIMARY KEY,
 label text,
 city text,
 region text,
 country text,
 retry_after timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS travel_lookup_settings (
 id integer PRIMARY KEY CHECK(id=1),
 enabled boolean NOT NULL DEFAULT true,
 endpoint text NOT NULL DEFAULT 'https://nominatim.openstreetmap.org/reverse',
 next_request_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO travel_lookup_settings(id) VALUES(1) ON CONFLICT DO NOTHING;
