-- PostgreSQL: allow custom gallery roles to use the read-only admin profile.
BEGIN;
ALTER TABLE gallery_access_objects DROP CONSTRAINT IF EXISTS gallery_access_objects_profile_check;
ALTER TABLE gallery_access_objects ADD CONSTRAINT gallery_access_objects_profile_check
 CHECK (profile IN ('viewer','admin','admin_readonly'));
COMMIT;
