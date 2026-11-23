BEGIN;
ALTER TABLE gallery_access_objects ADD COLUMN IF NOT EXISTS auth0_user_id TEXT;
ALTER TABLE gallery_access_objects ADD COLUMN IF NOT EXISTS deleting BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS gallery_access_auth0_identity ON gallery_access_objects(auth0_user_id) WHERE auth0_user_id IS NOT NULL;
COMMIT;
