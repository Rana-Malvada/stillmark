-- Additive authority migration. No users are implicitly granted access.
SET LOCAL lock_timeout='5s';
CREATE TABLE photo_security.app_principals (
 marker uuid PRIMARY KEY REFERENCES public.gallery_access_objects(marker) ON DELETE CASCADE,
 enabled boolean NOT NULL DEFAULT true,
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0)
);
CREATE TABLE photo_security.app_roles (
 role_key text PRIMARY KEY,
 profile text CHECK(profile IN ('viewer','admin','admin_readonly','app_owner')),
 access_manager boolean NOT NULL DEFAULT false,
 marker uuid UNIQUE REFERENCES public.gallery_access_objects(marker) ON DELETE CASCADE,
 CHECK(profile IS NOT NULL OR access_manager)
);
INSERT INTO photo_security.app_roles(role_key,profile,access_manager) VALUES
 ('viewer','viewer',false),('admin','admin',false),('admin_readonly','admin_readonly',false),
 ('app_owner','app_owner',true),('access_manager',NULL,true);
CREATE TABLE photo_security.app_memberships (
 marker uuid NOT NULL REFERENCES photo_security.app_principals(marker) ON DELETE CASCADE,
 role_key text NOT NULL REFERENCES photo_security.app_roles(role_key) ON DELETE CASCADE,
 PRIMARY KEY(marker,role_key)
);
CREATE INDEX app_memberships_role ON photo_security.app_memberships(role_key,marker);
CREATE TABLE photo_security.app_permission_audit (
 operation_id uuid PRIMARY KEY,
 actor text NOT NULL,
 target_marker uuid NOT NULL,
 action text NOT NULL,
 value text NOT NULL,
 changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE photo_security.app_principals ENABLE ROW LEVEL SECURITY;
ALTER TABLE photo_security.app_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE photo_security.app_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE photo_security.app_permission_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON photo_security.app_principals,photo_security.app_roles,photo_security.app_memberships,photo_security.app_permission_audit FROM PUBLIC,personal_photos_app;

CREATE FUNCTION photo_security.app_permission_snapshot(p_marker uuid)
RETURNS TABLE(enabled boolean,revision bigint,app_role text,app_owner boolean,can_manage_personal boolean,can_manage_access boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT p.enabled,p.revision,
 CASE WHEN bool_or(r.profile IN ('admin','app_owner')) THEN 'admin'
      WHEN bool_or(r.profile='admin_readonly') THEN 'admin_readonly'
      WHEN bool_or(r.profile='viewer') THEN 'viewer' END,
 coalesce(bool_or(r.profile='app_owner'),false),
 coalesce(bool_or(r.profile IN ('viewer','admin','app_owner')),false),
 coalesce(bool_or(r.access_manager OR r.profile='app_owner'),false)
 FROM photo_security.app_principals p
 LEFT JOIN photo_security.app_memberships m ON m.marker=p.marker
 LEFT JOIN photo_security.app_roles r USING(role_key)
 WHERE p.marker=p_marker GROUP BY p.marker
$$;

-- Keep the existing assertion claim, replay protection and logout checks. The
-- joined permissions are read from the primary in the same statement snapshot.
CREATE FUNCTION photo_security.gateway_app_identity_once(subject text,session_id uuid,assertion_id uuid,expiry bigint)
RETURNS TABLE(name text,marker uuid,revoked boolean,epoch bigint,enabled boolean,app_role text,app_owner boolean,can_manage_personal boolean,can_manage_access boolean,main_admin boolean)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT i.name,i.marker,i.revoked,p.revision,p.enabled,p.app_role,p.app_owner,p.can_manage_personal,p.can_manage_access,
 EXISTS(SELECT FROM public.gallery_main_admins a WHERE a.username=i.name)
 FROM photo_security.gateway_identity_once(subject,session_id,assertion_id,expiry) i
 LEFT JOIN LATERAL photo_security.app_permission_snapshot(i.marker) p ON true
$$;
CREATE FUNCTION photo_security.native_app_identity(p_name text)
RETURNS TABLE(name text,marker uuid,revoked boolean,epoch bigint,enabled boolean,app_role text,app_owner boolean,can_manage_personal boolean,can_manage_access boolean,main_admin boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT o.name,o.marker,false,p.revision,p.enabled,p.app_role,p.app_owner,p.can_manage_personal,p.can_manage_access,
 EXISTS(SELECT FROM public.gallery_main_admins a WHERE a.username=o.name)
 FROM public.gallery_access_objects o
 LEFT JOIN LATERAL photo_security.app_permission_snapshot(o.marker) p ON true
 WHERE o.kind='user' AND o.name=p_name AND o.state='ready' AND NOT o.deleting
$$;

CREATE FUNCTION photo_security.assert_app_access_manager() RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE owner boolean;
BEGIN
 SELECT i.app_owner INTO owner FROM photo_security.native_app_identity(photo_security.username()) i
 WHERE i.enabled AND i.can_manage_access AND i.app_role IS NOT NULL;
 IF owner IS NULL THEN RAISE EXCEPTION 'Access manager required' USING ERRCODE='42501'; END IF;
 RETURN owner;
END $$;

CREATE FUNCTION photo_security.register_app_principal(p_name text,p_marker uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM photo_security.assert_app_access_manager();
 IF NOT EXISTS(SELECT FROM public.gallery_access_objects WHERE kind='user' AND name=p_name AND marker=p_marker AND state='ready' AND NOT deleting)
 THEN RAISE EXCEPTION 'Account registry mismatch' USING ERRCODE='42501'; END IF;
 INSERT INTO photo_security.app_principals(marker) VALUES(p_marker) ON CONFLICT DO NOTHING;
END $$;
CREATE FUNCTION photo_security.register_app_role(p_name text,p_marker uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM photo_security.assert_app_access_manager();
 INSERT INTO photo_security.app_roles(role_key,profile,marker)
 SELECT 'group:'||o.name,o.profile,o.marker FROM public.gallery_access_objects o
 WHERE o.kind='role' AND o.name=p_name AND o.marker=p_marker AND o.state='ready'
 AND o.profile IN ('viewer','admin','admin_readonly')
 ON CONFLICT(role_key) DO NOTHING;
 IF NOT EXISTS(SELECT FROM photo_security.app_roles WHERE role_key='group:'||p_name AND marker=p_marker)
 THEN RAISE EXCEPTION 'Role registry mismatch' USING ERRCODE='42501'; END IF;
END $$;

CREATE FUNCTION photo_security.change_app_permission(p_operation uuid,p_name text,p_marker uuid,p_action text,p_value text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE is_owner boolean; previous photo_security.app_permission_audit%ROWTYPE; protected_role boolean;
BEGIN
 -- Administrative writes are rare. Serialize them to protect last-owner checks,
 -- audit idempotency and competing grants; ordinary reads take no such lock.
 PERFORM pg_advisory_xact_lock(hashtextextended('stillmark-app-permission-management',0));
 is_owner:=photo_security.assert_app_access_manager();
 IF p_name=photo_security.username() THEN RAISE EXCEPTION 'Self access changes are prohibited' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT FROM public.gallery_access_objects o JOIN photo_security.app_principals p USING(marker)
  WHERE o.kind='user' AND o.name=p_name AND o.marker=p_marker AND o.state='ready' AND NOT o.deleting)
 THEN RAISE EXCEPTION 'Account registry mismatch' USING ERRCODE='42501'; END IF;
 SELECT * INTO previous FROM photo_security.app_permission_audit WHERE operation_id=p_operation;
 IF FOUND THEN
  IF previous.actor<>photo_security.username() OR previous.target_marker<>p_marker OR previous.action<>p_action OR previous.value<>p_value
  THEN RAISE EXCEPTION 'Operation ID conflict' USING ERRCODE='23505'; END IF;
  RETURN;
 END IF;
 PERFORM 1 FROM photo_security.app_principals WHERE marker=p_marker FOR UPDATE;
 IF p_action IN ('grant','revoke') THEN
  SELECT profile='app_owner' OR access_manager INTO protected_role FROM photo_security.app_roles WHERE role_key=p_value;
  IF protected_role IS NULL THEN RAISE EXCEPTION 'Unknown app role' USING ERRCODE='22023'; END IF;
  IF protected_role AND NOT is_owner THEN RAISE EXCEPTION 'App owner required' USING ERRCODE='42501'; END IF;
  IF p_action='grant' THEN
   INSERT INTO photo_security.app_memberships(marker,role_key) VALUES(p_marker,p_value) ON CONFLICT DO NOTHING;
  ELSE
   DELETE FROM photo_security.app_memberships WHERE marker=p_marker AND role_key=p_value;
  END IF;
 ELSIF p_action='enabled' AND p_value IN ('true','false') THEN
  IF (EXISTS(SELECT FROM photo_security.app_permission_snapshot(p_marker) WHERE app_owner OR can_manage_access)) AND NOT is_owner
  THEN RAISE EXCEPTION 'App owner required' USING ERRCODE='42501'; END IF;
  UPDATE photo_security.app_principals SET enabled=p_value::boolean WHERE marker=p_marker;
 ELSE RAISE EXCEPTION 'Unknown permission action' USING ERRCODE='22023';
 END IF;
 IF NOT EXISTS(SELECT FROM photo_security.app_memberships m JOIN photo_security.app_roles r USING(role_key)
 JOIN photo_security.app_principals p ON p.marker=m.marker JOIN public.gallery_access_objects o ON o.marker=m.marker
 WHERE r.profile='app_owner' AND p.enabled AND o.kind='user' AND o.state='ready' AND NOT o.deleting)
 THEN RAISE EXCEPTION 'At least one active app owner is required' USING ERRCODE='42501'; END IF;
 UPDATE photo_security.app_principals SET revision=revision+1 WHERE marker=p_marker;
 INSERT INTO photo_security.app_permission_audit(operation_id,actor,target_marker,action,value)
 VALUES(p_operation,photo_security.username(),p_marker,p_action,p_value);
END $$;
CREATE FUNCTION photo_security.app_member_roles(p_marker uuid) RETURNS TABLE(role_key text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT EXISTS(SELECT FROM photo_security.native_app_identity(photo_security.username()) i WHERE i.enabled AND (i.can_manage_access OR i.app_role IN ('admin','admin_readonly')))
 THEN RAISE EXCEPTION 'Access review required' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT m.role_key FROM photo_security.app_memberships m WHERE m.marker=p_marker ORDER BY m.role_key;
END $$;
REVOKE ALL ON FUNCTION photo_security.app_permission_snapshot(uuid),photo_security.assert_app_access_manager(),photo_security.gateway_app_identity_once(text,uuid,uuid,bigint),photo_security.native_app_identity(text),photo_security.register_app_principal(text,uuid),photo_security.register_app_role(text,uuid),photo_security.change_app_permission(uuid,text,uuid,text,text),photo_security.app_member_roles(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION photo_security.gateway_app_identity_once(text,uuid,uuid,bigint),photo_security.native_app_identity(text),photo_security.register_app_principal(text,uuid),photo_security.register_app_role(text,uuid),photo_security.change_app_permission(uuid,text,uuid,text,text),photo_security.app_member_roles(uuid) TO personal_photos_app;
CREATE FUNCTION photo_security.app_access_overview()
RETURNS TABLE(marker uuid,enabled boolean,roles text[])
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT EXISTS(SELECT FROM photo_security.native_app_identity(photo_security.username()) i WHERE i.enabled AND (i.can_manage_access OR i.app_role IN ('admin','admin_readonly')))
 THEN RAISE EXCEPTION 'Access review required' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT p.marker,p.enabled,coalesce(array_agg(m.role_key ORDER BY m.role_key) FILTER(WHERE m.role_key IS NOT NULL),ARRAY[]::text[])
 FROM photo_security.app_principals p LEFT JOIN photo_security.app_memberships m ON m.marker=p.marker GROUP BY p.marker;
END $$;
REVOKE ALL ON FUNCTION photo_security.app_access_overview() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION photo_security.app_access_overview() TO personal_photos_app;
