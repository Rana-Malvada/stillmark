-- Additive: old app versions continue to use gateway_identity during rollout.
CREATE TABLE photo_security.gateway_assertions (
 jti uuid PRIMARY KEY,
 expires_at timestamptz NOT NULL
);
CREATE INDEX gateway_assertions_expiry ON photo_security.gateway_assertions(expires_at);
ALTER TABLE photo_security.gateway_assertions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON photo_security.gateway_assertions FROM PUBLIC, personal_photos_app;
CREATE TABLE photo_security.authorization_revision (
 id boolean PRIMARY KEY DEFAULT true CHECK(id),
 revision bigint NOT NULL DEFAULT 1
);
INSERT INTO photo_security.authorization_revision DEFAULT VALUES;
ALTER TABLE photo_security.authorization_revision ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON photo_security.authorization_revision FROM PUBLIC, personal_photos_app;
CREATE FUNCTION photo_security.authorization_epoch() RETURNS bigint
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS
 $$ SELECT revision FROM photo_security.authorization_revision WHERE id $$;
CREATE FUNCTION photo_security.invalidate_authorization() RETURNS void
 LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS
 $$ UPDATE photo_security.authorization_revision SET revision=revision+1
 WHERE id AND photo_security.flag('access_manager') $$;
CREATE FUNCTION photo_security.gateway_identity_once(subject text, session_id uuid, assertion_id uuid, expiry bigint)
 RETURNS TABLE(name text, marker uuid, revoked boolean, epoch bigint)
 LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
 WITH cleanup AS (
  DELETE FROM photo_security.gateway_assertions WHERE jti IN (
   SELECT jti FROM photo_security.gateway_assertions WHERE expires_at < clock_timestamp()
   ORDER BY expires_at LIMIT 64 FOR UPDATE SKIP LOCKED
  )
 ), claim AS (
  INSERT INTO photo_security.gateway_assertions(jti,expires_at)
  SELECT assertion_id,to_timestamp(expiry)+interval '5 seconds'
  WHERE expiry > extract(epoch FROM clock_timestamp())
    AND expiry <= extract(epoch FROM clock_timestamp())+35
  ON CONFLICT DO NOTHING RETURNING jti
 )
 SELECT i.name,i.marker,i.revoked,photo_security.authorization_epoch()
 FROM claim CROSS JOIN photo_security.gateway_identity(subject,session_id) i
 $$;
REVOKE ALL ON FUNCTION photo_security.authorization_epoch(),photo_security.invalidate_authorization(),photo_security.gateway_identity_once(text,uuid,uuid,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION photo_security.authorization_epoch(),photo_security.invalidate_authorization(),photo_security.gateway_identity_once(text,uuid,uuid,bigint) TO personal_photos_app;
