BEGIN;
CREATE TABLE IF NOT EXISTS gallery_main_admins(username text PRIMARY KEY);
INSERT INTO gallery_main_admins(username) VALUES('EXAMPLEADMIN') ON CONFLICT DO NOTHING;
ALTER TABLE events ADD COLUMN IF NOT EXISTS owner_username text;
-- Legacy albums were visible to every authenticated gallery user. Preserve that deliberately.
UPDATE events SET owner_username='EXAMPLEADMIN',visibility='GALLERY' WHERE owner_username IS NULL;
ALTER TABLE events ALTER COLUMN owner_username SET NOT NULL;
-- Compatibility for the previous deployment during a rolling upgrade.
-- New application writes always supply the authenticated owner explicitly.
ALTER TABLE events ALTER COLUMN owner_username SET DEFAULT 'EXAMPLEADMIN';
ALTER TABLE events ALTER COLUMN visibility SET DEFAULT 'PRIVATE';
CREATE INDEX IF NOT EXISTS events_owner ON events(owner_username);
CREATE TABLE IF NOT EXISTS album_shares(
 event_id integer NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
 username text NOT NULL,
 created_by text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(event_id,username)
);
CREATE INDEX IF NOT EXISTS album_shares_user ON album_shares(username,event_id);
ALTER TABLE photo_trash ADD COLUMN IF NOT EXISTS owner_username text;
UPDATE photo_trash t SET owner_username=COALESCE((SELECT e.owner_username FROM events e WHERE e.event_id=(t.photo_data->>'event_id')::int),'EXAMPLEADMIN') WHERE owner_username IS NULL;
ALTER TABLE photo_trash ALTER COLUMN owner_username SET NOT NULL;
-- Snapshot ownership before albums disappear, so private trash remains private.
CREATE OR REPLACE FUNCTION set_trash_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.owner_username IS NULL THEN
  SELECT owner_username INTO NEW.owner_username FROM events WHERE event_id=(NEW.photo_data->>'event_id')::int;
 END IF;
 IF NEW.owner_username IS NULL THEN RAISE EXCEPTION 'Trash owner is required'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS photo_trash_owner ON photo_trash;
CREATE TRIGGER photo_trash_owner BEFORE INSERT ON photo_trash FOR EACH ROW EXECUTE FUNCTION set_trash_owner();
COMMIT;
