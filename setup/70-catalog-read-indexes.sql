-- Run without a transaction; existing compute only. Does not change application semantics.
CREATE INDEX CONCURRENTLY IF NOT EXISTS events_page_sort_idx ON events ((COALESCE(sort_order,0)),event_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS photos_event_gps_idx ON photos(event_id,latitude,longitude) WHERE latitude IS NOT NULL AND longitude IS NOT NULL;
