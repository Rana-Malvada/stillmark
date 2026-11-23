SET LOCAL lock_timeout='5s';

-- The shared fence lives only for the caller's transaction. Publication and
-- enqueue take it before queue/session locks; deletion takes its exclusive peer.
CREATE FUNCTION photo_security.upload_account_allowed(p_owner text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF p_owner IS NULL OR p_owner IS DISTINCT FROM photo_security.username() THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('upload-account:'||p_owner,0));
 RETURN EXISTS(
  SELECT FROM photo_security.native_app_identity(p_owner) i
  LEFT JOIN photo_security.customer_accounts c ON c.marker=i.marker
  WHERE i.enabled AND i.can_manage_personal AND c.deletion_requested_at IS NULL
 );
END $$;
REVOKE ALL ON FUNCTION photo_security.upload_account_allowed(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION photo_security.upload_account_allowed(text) TO personal_photos_app;

CREATE OR REPLACE FUNCTION photo_security.request_account_deletion() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE target uuid; owner_name text:=photo_security.username();
BEGIN
 IF owner_name IS NULL THEN RAISE EXCEPTION 'Account identity required' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('upload-account:'||owner_name,0));
 SELECT c.marker INTO target FROM photo_security.customer_accounts c JOIN public.gallery_access_objects o USING(marker)
 WHERE o.kind='user' AND o.name=owner_name;
 IF target IS NULL THEN RAISE EXCEPTION 'Contact an administrator to delete this account' USING ERRCODE='42501'; END IF;
 IF EXISTS(SELECT FROM photo_security.app_permission_snapshot(target) WHERE app_owner OR can_manage_access)
 THEN RAISE EXCEPTION 'Administrators must transfer ownership before deletion' USING ERRCODE='42501'; END IF;
 -- Match the existing queue -> session lock order, including older consumers.
 PERFORM upload_id FROM public.upload_processing_jobs WHERE owner=owner_name ORDER BY upload_id FOR UPDATE;
 UPDATE photo_security.customer_accounts SET deletion_requested_at=coalesce(deletion_requested_at,clock_timestamp()) WHERE marker=target;
 UPDATE photo_security.app_principals SET enabled=false,revision=revision+1 WHERE marker=target;
 UPDATE public.album_public_links SET revoked_at=coalesce(revoked_at,clock_timestamp()) WHERE owner_username=owner_name;
 -- Cancellation is deletion, not a failed processing attempt. Cascades remove
 -- jobs/chunks/reservations; durable stage_cleanup intents remain for reclamation.
 -- Successful replay records and published media are retained.
 DELETE FROM public.upload_sessions WHERE owner=owner_name AND result IS NULL;
END $$;
REVOKE ALL ON FUNCTION photo_security.request_account_deletion() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION photo_security.request_account_deletion() TO personal_photos_app;
