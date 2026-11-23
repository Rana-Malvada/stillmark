-- GALLERY means shared with every authenticated application user, including
-- self-service accounts. Preserve the existing private/explicit-share policies.
SET LOCAL lock_timeout='5s';
CREATE OR REPLACE FUNCTION photo_security.legacy_collection_access() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT photo_security.username() IS NOT NULL
$$;
COMMENT ON FUNCTION photo_security.legacy_collection_access() IS
 'Compatibility helper: GALLERY access applies to all authenticated application accounts.';
