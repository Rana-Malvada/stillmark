CREATE OR REPLACE FUNCTION photo_security.register_customer(p_subject text,p_issuer text,p_email text,p_display text,
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
 RETURN new_name;
END $$;

