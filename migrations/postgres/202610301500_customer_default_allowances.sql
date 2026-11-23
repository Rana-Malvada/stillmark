-- Admin-only defaults. Existing customer budgets and registration gates are unchanged.
CREATE FUNCTION photo_security.customer_default_allowances() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result jsonb;
BEGIN
 PERFORM photo_security.assert_app_access_manager();
 SELECT jsonb_build_object('uploads',default_uploads,'bytes',default_bytes) INTO result
 FROM photo_security.registration_settings WHERE singleton;
 RETURN result;
END $$;

CREATE FUNCTION photo_security.set_customer_default_allowances(p_uploads bigint,p_bytes bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE previous jsonb; actor_marker uuid;
BEGIN
 PERFORM photo_security.assert_app_access_manager();
 IF p_uploads IS NULL OR p_bytes IS NULL OR p_uploads<0 OR p_uploads>1000000 OR p_bytes<0 OR p_bytes>10995116277760
 THEN RAISE EXCEPTION 'Invalid allowance'; END IF;
 SELECT marker INTO STRICT actor_marker FROM public.gallery_access_objects
 WHERE kind='user' AND name=photo_security.username();
 SELECT jsonb_build_object('uploads',default_uploads,'bytes',default_bytes) INTO previous
 FROM photo_security.registration_settings WHERE singleton FOR UPDATE;
 UPDATE photo_security.registration_settings SET default_uploads=p_uploads,default_bytes=p_bytes WHERE singleton;
 INSERT INTO photo_security.app_permission_audit(operation_id,actor,target_marker,action,value)
 VALUES(gen_random_uuid(),photo_security.username(),actor_marker,'customer_default_allowances',
 jsonb_build_object('before',previous,'after',jsonb_build_object('uploads',p_uploads,'bytes',p_bytes))::text);
END $$;
REVOKE ALL ON FUNCTION photo_security.customer_default_allowances(),photo_security.set_customer_default_allowances(bigint,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION photo_security.customer_default_allowances(),photo_security.set_customer_default_allowances(bigint,bigint) TO personal_photos_app;
