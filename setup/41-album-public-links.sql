BEGIN;
CREATE TABLE IF NOT EXISTS album_public_links (
 id uuid PRIMARY KEY,
 event_id integer NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
 token_hash text UNIQUE NOT NULL,
 owner_username text NOT NULL,
 created_by text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 allow_downloads boolean NOT NULL DEFAULT false,
 revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS album_public_links_event ON album_public_links(event_id);
GRANT SELECT,INSERT,UPDATE,DELETE ON album_public_links TO personal_photos_app;
COMMIT;
