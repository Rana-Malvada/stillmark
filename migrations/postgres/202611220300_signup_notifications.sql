SET LOCAL lock_timeout='5s';
-- Recent self-registrations for the gateway's signed monitor. No email address,
-- login subject or username is returned; the marker is an opaque notification key.
CREATE FUNCTION photo_security.recent_public_signups()
RETURNS TABLE(id uuid,created_at timestamptz,display_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT o.marker,o.created_at,o.display_name FROM public.gallery_access_objects o
 WHERE o.kind='user' AND o.registration_source='public'
 AND o.created_at>=statement_timestamp()-interval '48 hours'
 ORDER BY o.created_at,o.marker LIMIT 200
$$;
REVOKE ALL ON FUNCTION photo_security.recent_public_signups() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION photo_security.recent_public_signups() TO personal_photos_maintenance;
