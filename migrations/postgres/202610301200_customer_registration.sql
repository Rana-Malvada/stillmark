-- Registration is disabled until Auth0/email/recovery configuration is verified.
SET LOCAL lock_timeout='5s';
ALTER TABLE public.gallery_access_objects ADD COLUMN registration_source text NOT NULL DEFAULT 'managed'
 CHECK(registration_source IN ('managed','public'));
CREATE INDEX customer_registration_admission ON public.gallery_access_objects(created_at) WHERE registration_source='public';
CREATE TABLE photo_security.registration_settings (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 enabled boolean NOT NULL DEFAULT false,
 issuer text NOT NULL DEFAULT '',
 default_ai_searches integer NOT NULL DEFAULT 0 CHECK(default_ai_searches BETWEEN 0 AND 10000),
 default_uploads bigint NOT NULL DEFAULT 0 CHECK(default_uploads>=0),
 default_bytes bigint NOT NULL DEFAULT 0 CHECK(default_bytes>=0),
 daily_signups integer NOT NULL DEFAULT 100 CHECK(daily_signups BETWEEN 1 AND 10000)
);
INSERT INTO photo_security.registration_settings DEFAULT VALUES;
CREATE TABLE photo_security.customer_accounts (
 marker uuid PRIMARY KEY REFERENCES public.gallery_access_objects(marker) ON DELETE CASCADE,
 issuer text NOT NULL,
 subject text NOT NULL,
 ai_search_limit integer NOT NULL DEFAULT 0 CHECK(ai_search_limit BETWEEN 0 AND 10000),
 ai_search_day date,
 ai_searches integer NOT NULL DEFAULT 0,
 upload_limit bigint NOT NULL CHECK(upload_limit>=0),
 byte_limit bigint NOT NULL CHECK(byte_limit>=0),
 admitted_uploads bigint NOT NULL DEFAULT 0,
 admitted_bytes bigint NOT NULL DEFAULT 0,
 deletion_requested_at timestamptz,
 UNIQUE(issuer,subject)
);
CREATE TABLE photo_security.credential_cutoffs (
 subject text PRIMARY KEY,
 cutoff bigint NOT NULL CHECK(cutoff>0)
);
ALTER TABLE photo_security.registration_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE photo_security.customer_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE photo_security.credential_cutoffs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON photo_security.registration_settings,photo_security.customer_accounts,photo_security.credential_cutoffs FROM PUBLIC,personal_photos_app;
INSERT INTO photo_security.app_roles(role_key,profile,access_manager) VALUES
 ('member','viewer',false),('administrator','app_owner',true);
-- Preserve the requested administrator, using its existing immutable registry ID.
INSERT INTO photo_security.app_memberships(marker,role_key)
 SELECT o.marker,'administrator' FROM public.gallery_access_objects o
 JOIN photo_security.app_principals p USING(marker)
 WHERE o.kind='user' AND o.name='GALLERYOWNER' AND o.state='ready' AND NOT o.deleting
 ON CONFLICT DO NOTHING;

CREATE FUNCTION photo_security.register_customer(p_subject text,p_issuer text,p_email text,p_display text,
 p_verified boolean,p_assertion uuid,p_expiry bigint)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE settings photo_security.registration_settings%ROWTYPE; existing public.gallery_access_objects%ROWTYPE;
 new_marker uuid; new_name text;
BEGIN
 IF p_subject NOT LIKE 'auth0|%' OR length(p_subject)>200 OR p_issuer IS NULL
 THEN RAISE EXCEPTION 'Invalid identity' USING ERRCODE='42501'; END IF;
 INSERT INTO photo_security.gateway_assertions(jti,expires_at)
 SELECT p_assertion,to_timestamp(p_expiry)+interval '5 seconds'
 WHERE p_expiry>extract(epoch FROM clock_timestamp()) AND p_expiry<=extract(epoch FROM clock_timestamp())+35
 ON CONFLICT DO NOTHING;
 IF NOT FOUND THEN RAISE EXCEPTION 'Expired or replayed assertion' USING ERRCODE='42501'; END IF;
 -- Registration is rare; this lock also makes the global admission ceiling atomic.
 PERFORM pg_advisory_xact_lock(hashtextextended('stillmark-registration',0));
 SELECT * INTO settings FROM photo_security.registration_settings WHERE singleton;
 IF settings.issuer<>p_issuer OR settings.issuer='' THEN RAISE EXCEPTION 'Issuer mismatch' USING ERRCODE='42501'; END IF;
 SELECT * INTO existing FROM public.gallery_access_objects WHERE kind='user' AND auth0_user_id=p_subject;
 IF FOUND THEN
  IF existing.deleting OR existing.state<>'ready' OR NOT EXISTS(
   SELECT FROM photo_security.app_principals WHERE marker=existing.marker AND enabled)
  THEN RAISE EXCEPTION 'Account unavailable' USING ERRCODE='42501'; END IF;
  IF existing.registration_source='public' AND (p_verified IS DISTINCT FROM true OR NOT EXISTS(
   SELECT FROM photo_security.customer_accounts WHERE marker=existing.marker AND issuer=p_issuer AND subject=p_subject AND deletion_requested_at IS NULL))
  THEN RAISE EXCEPTION 'Verified account required' USING ERRCODE='42501'; END IF;
  RETURN existing.name;
 END IF;
 IF NOT settings.enabled THEN RAISE EXCEPTION 'Registration closed' USING ERRCODE='42501'; END IF;
 IF p_verified IS DISTINCT FROM true OR p_email IS NULL OR length(p_email)>254 OR p_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
 OR p_display IS NULL OR length(p_display) NOT BETWEEN 1 AND 120
 THEN RAISE EXCEPTION 'Verified email and display name required' USING ERRCODE='42501'; END IF;
 IF (SELECT count(*) FROM public.gallery_access_objects WHERE registration_source='public' AND created_at>=statement_timestamp()-interval '24 hours')>=settings.daily_signups
 THEN RAISE EXCEPTION 'Registration capacity reached' USING ERRCODE='53000'; END IF;
 new_marker:=gen_random_uuid(); new_name:='U_'||replace(new_marker::text,'-','');
 INSERT INTO public.gallery_access_objects(kind,name,marker,profile,display_name,email,created_by,state,auth0_user_id,registration_source)
 VALUES('user',new_name,new_marker,'viewer',p_display,p_email,'SELF_REGISTRATION','ready',p_subject,'public');
 INSERT INTO photo_security.app_principals(marker) VALUES(new_marker);
 INSERT INTO photo_security.app_memberships(marker,role_key) VALUES(new_marker,'member');
 INSERT INTO photo_security.customer_accounts(marker,issuer,subject,upload_limit,byte_limit,ai_search_limit)
 VALUES(new_marker,p_issuer,p_subject,settings.default_uploads,settings.default_bytes,settings.default_ai_searches);
 INSERT INTO public.folders(folder_name,owner_username) VALUES('My albums',new_name);
 RETURN new_name;
END $$;

-- Only legacy members have implicit access to the original shared collection.
CREATE FUNCTION photo_security.legacy_collection_access() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT photo_security.username() IS NOT NULL AND NOT EXISTS(
 SELECT FROM public.gallery_access_objects WHERE kind='user' AND name=photo_security.username() AND registration_source='public')
$$;
CREATE OR REPLACE FUNCTION photo_security.read_event(id integer) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT FROM public.events e WHERE e.event_id=id AND (
 (photo_security.username() IS NOT NULL AND (photo_security.flag('main_admin') OR e.owner_username=photo_security.username()
 OR (e.visibility='GALLERY' AND photo_security.legacy_collection_access())
 OR EXISTS(SELECT FROM public.album_shares s WHERE s.event_id=e.event_id AND s.username=photo_security.username())))
 OR e.event_id=photo_security.public_event()))
$$;
CREATE OR REPLACE FUNCTION photo_security.readable_events() RETURNS SETOF integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 WITH caller AS MATERIALIZED (
  SELECT photo_security.username() AS username,
         photo_security.flag('main_admin') AS main_admin,
         photo_security.public_event() AS public_event,
         photo_security.legacy_collection_access() AS legacy_access
 )
 SELECT e.event_id FROM public.events e CROSS JOIN caller c
 WHERE c.username IS NOT NULL AND c.main_admin
 UNION
 SELECT e.event_id FROM public.events e CROSS JOIN caller c
 WHERE c.username IS NOT NULL AND NOT c.main_admin AND e.owner_username=c.username
 UNION
 SELECT e.event_id FROM public.events e CROSS JOIN caller c
 WHERE c.username IS NOT NULL AND NOT c.main_admin AND c.legacy_access AND e.visibility='GALLERY'
 UNION
 SELECT e.event_id FROM public.album_shares s JOIN public.events e USING(event_id) CROSS JOIN caller c
 WHERE c.username IS NOT NULL AND NOT c.main_admin AND s.username=c.username
 UNION
 SELECT e.event_id FROM public.events e CROSS JOIN caller c WHERE e.event_id=c.public_event
$$;

ALTER POLICY app_read ON public.events USING (
 ((SELECT photo_security.username()) IS NOT NULL AND (
 (SELECT photo_security.flag('main_admin')) OR owner_username=(SELECT photo_security.username())
 OR (visibility='GALLERY' AND (SELECT photo_security.legacy_collection_access()))
 OR event_id IN (SELECT photo_security.shared_events()))) OR event_id=(SELECT photo_security.public_event())
);
-- Credential changes invalidate all older sessions; retries/out-of-order events cannot lower the cutoff.
CREATE FUNCTION photo_security.record_credential_change(p_subject text,p_cutoff bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF p_subject NOT LIKE 'auth0|%' OR length(p_subject)>200 OR p_cutoff<=0 OR p_cutoff>extract(epoch FROM clock_timestamp())+5
 THEN RAISE EXCEPTION 'Invalid credential event' USING ERRCODE='42501'; END IF;
 INSERT INTO photo_security.credential_cutoffs(subject,cutoff) VALUES(p_subject,p_cutoff)
 ON CONFLICT(subject) DO UPDATE SET cutoff=greatest(credential_cutoffs.cutoff,excluded.cutoff);
END $$;
CREATE FUNCTION photo_security.gateway_customer_identity_once(subject text,session_id uuid,assertion_id uuid,expiry bigint,started_at bigint)
RETURNS TABLE(name text,marker uuid,revoked boolean,epoch bigint,enabled boolean,app_role text,app_owner boolean,can_manage_personal boolean,can_manage_access boolean,main_admin boolean)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog ROWS 1 AS $$
 SELECT i.name,i.marker,i.revoked OR (c.cutoff IS NOT NULL AND (started_at IS NULL OR started_at<=c.cutoff)),
 i.epoch,i.enabled,i.app_role,i.app_owner,i.can_manage_personal,i.can_manage_access,i.main_admin
 FROM photo_security.gateway_app_identity_once(subject,session_id,assertion_id,expiry) i
 LEFT JOIN photo_security.credential_cutoffs c ON c.subject=$1
$$;

-- Lifetime admission budgets include failed/cancelled uploads to bound storage and AI abuse.
-- Administrators can replenish them; retries of the same upload do not reserve twice.
CREATE FUNCTION photo_security.customer_upload_budget() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE account photo_security.customer_accounts%ROWTYPE; reserved_bytes bigint;
BEGIN
 SELECT c.* INTO account FROM photo_security.customer_accounts c JOIN public.gallery_access_objects o USING(marker)
 WHERE o.kind='user' AND o.name=NEW.owner FOR UPDATE OF c;
 IF NOT FOUND THEN RETURN NEW; END IF;
 reserved_bytes:=NEW.total_chunks::bigint*8388608;
 IF account.deletion_requested_at IS NOT NULL OR account.admitted_uploads>=account.upload_limit
 OR account.admitted_bytes+reserved_bytes>account.byte_limit THEN
 RAISE EXCEPTION 'Account upload allowance reached; contact an administrator' USING ERRCODE='P0001'; END IF;
 UPDATE photo_security.customer_accounts SET admitted_uploads=admitted_uploads+1,admitted_bytes=admitted_bytes+reserved_bytes WHERE marker=account.marker;
 RETURN NEW;
END $$;
CREATE TRIGGER customer_upload_admission BEFORE INSERT ON public.upload_sessions FOR EACH ROW EXECUTE FUNCTION photo_security.customer_upload_budget();

CREATE FUNCTION photo_security.request_account_deletion() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE target uuid;
BEGIN
 SELECT c.marker INTO target FROM photo_security.customer_accounts c JOIN public.gallery_access_objects o USING(marker)
 WHERE o.kind='user' AND o.name=photo_security.username();
 IF target IS NULL THEN RAISE EXCEPTION 'Contact an administrator to delete this account' USING ERRCODE='42501'; END IF;
 IF EXISTS(SELECT FROM photo_security.app_permission_snapshot(target) WHERE app_owner OR can_manage_access)
 THEN RAISE EXCEPTION 'Administrators must transfer ownership before deletion' USING ERRCODE='42501'; END IF;
 UPDATE photo_security.customer_accounts SET deletion_requested_at=coalesce(deletion_requested_at,clock_timestamp()) WHERE marker=target;
 UPDATE photo_security.app_principals SET enabled=false,revision=revision+1 WHERE marker=target;
 UPDATE public.album_public_links SET revoked_at=coalesce(revoked_at,clock_timestamp()) WHERE owner_username=photo_security.username();
END $$;
CREATE FUNCTION photo_security.update_customer_profile(p_display text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF length(trim(p_display)) NOT BETWEEN 1 AND 120 OR p_display ~ '[[:cntrl:]]' THEN RAISE EXCEPTION 'Invalid display name'; END IF;
 UPDATE public.gallery_access_objects SET display_name=trim(p_display)
 WHERE kind='user' AND name=photo_security.username() AND registration_source='public' AND NOT deleting;
 IF NOT FOUND THEN RAISE EXCEPTION 'Contact an administrator to update this profile' USING ERRCODE='42501'; END IF;
END $$;
REVOKE ALL ON FUNCTION photo_security.register_customer(text,text,text,text,boolean,uuid,bigint),photo_security.legacy_collection_access(),photo_security.record_credential_change(text,bigint),photo_security.gateway_customer_identity_once(text,uuid,uuid,bigint,bigint),photo_security.customer_upload_budget(),photo_security.request_account_deletion(),photo_security.update_customer_profile(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION photo_security.register_customer(text,text,text,text,boolean,uuid,bigint),photo_security.legacy_collection_access(),photo_security.record_credential_change(text,bigint),photo_security.gateway_customer_identity_once(text,uuid,uuid,bigint,bigint),photo_security.request_account_deletion(),photo_security.update_customer_profile(text) TO personal_photos_app;
CREATE FUNCTION photo_security.customer_account_details() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('displayName',o.display_name,'email',o.email,'publicAccount',o.registration_source='public',
 'uploadLimit',c.upload_limit,'uploadsUsed',c.admitted_uploads,'byteLimit',c.byte_limit,'bytesUsed',c.admitted_bytes)
 FROM public.gallery_access_objects o LEFT JOIN photo_security.customer_accounts c USING(marker)
 WHERE o.kind='user' AND o.name=photo_security.username() AND o.state='ready' AND NOT o.deleting
$$;
CREATE FUNCTION photo_security.set_customer_allowance(p_name text,p_uploads bigint,p_bytes bigint,p_ai_searches integer DEFAULT 0) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM photo_security.assert_app_access_manager();
 IF p_ai_searches IS NULL OR p_ai_searches<0 OR p_ai_searches>10000 OR p_uploads IS NULL OR p_bytes IS NULL OR p_uploads<0 OR p_uploads>1000000 OR p_bytes<0 OR p_bytes>10995116277760
 THEN RAISE EXCEPTION 'Invalid allowance'; END IF;
 UPDATE photo_security.customer_accounts c SET upload_limit=p_uploads,byte_limit=p_bytes,ai_search_limit=p_ai_searches
 FROM public.gallery_access_objects o WHERE o.marker=c.marker AND o.kind='user' AND o.name=p_name;
 IF NOT FOUND THEN RAISE EXCEPTION 'Customer account not found'; END IF;
 INSERT INTO photo_security.app_permission_audit(operation_id,actor,target_marker,action,value)
 SELECT gen_random_uuid(),photo_security.username(),o.marker,'allowance',p_uploads||' uploads / '||p_bytes||' bytes / '||p_ai_searches||' daily AI searches'
 FROM public.gallery_access_objects o WHERE o.kind='user' AND o.name=p_name;
END $$;
REVOKE ALL ON FUNCTION photo_security.customer_account_details(),photo_security.set_customer_allowance(text,bigint,bigint,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION photo_security.customer_account_details(),photo_security.set_customer_allowance(text,bigint,bigint,integer) TO personal_photos_app;

CREATE FUNCTION photo_security.admit_customer_search_ai() RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE account photo_security.customer_accounts%ROWTYPE; today date:=(statement_timestamp() AT TIME ZONE 'UTC')::date; used integer;
BEGIN
 IF photo_security.username() IS NULL THEN RETURN false; END IF;
 SELECT c.* INTO account FROM photo_security.customer_accounts c JOIN public.gallery_access_objects o USING(marker)
 WHERE o.kind='user' AND o.name=photo_security.username() FOR UPDATE OF c;
 IF NOT FOUND THEN RETURN true; END IF;
 used:=CASE WHEN account.ai_search_day=today THEN account.ai_searches ELSE 0 END;
 IF account.deletion_requested_at IS NOT NULL OR used>=account.ai_search_limit THEN RETURN false; END IF;
 UPDATE photo_security.customer_accounts SET ai_search_day=today,ai_searches=used+1 WHERE marker=account.marker;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION photo_security.admit_customer_search_ai() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION photo_security.admit_customer_search_ai() TO personal_photos_app;
