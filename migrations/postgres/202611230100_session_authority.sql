SET LOCAL lock_timeout='5s';
-- What a signed-in session may do right now, without consuming a gateway assertion.
-- A long response (a ZIP of many originals) outlives the assertion that started it; this
-- lets it ask again before each file. It reads the same rows as the sign-in functions:
-- the linked account, whether the session was logged out, the credential cutoff and the
-- account's current permissions. It grants nothing and changes nothing.
CREATE FUNCTION photo_security.gateway_session_authority(subject text,session_id uuid,started_at bigint,check_cutoff boolean)
RETURNS TABLE(name text,marker uuid,revoked boolean,epoch bigint,enabled boolean,app_role text,app_owner boolean,can_manage_personal boolean,can_manage_access boolean,main_admin boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog ROWS 1 AS $$
 SELECT i.name,i.marker,
 i.revoked OR (check_cutoff AND c.cutoff IS NOT NULL AND (started_at IS NULL OR started_at<=c.cutoff)),
 p.revision,p.enabled,p.app_role,p.app_owner,p.can_manage_personal,p.can_manage_access,
 EXISTS(SELECT FROM public.gallery_main_admins a WHERE a.username=i.name)
 FROM photo_security.gateway_identity(subject,session_id) i
 LEFT JOIN LATERAL photo_security.app_permission_snapshot(i.marker) p ON true
 LEFT JOIN photo_security.credential_cutoffs c ON c.subject=$1
$$;
REVOKE ALL ON FUNCTION photo_security.gateway_session_authority(text,uuid,bigint,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION photo_security.gateway_session_authority(text,uuid,bigint,boolean) TO personal_photos_app;
