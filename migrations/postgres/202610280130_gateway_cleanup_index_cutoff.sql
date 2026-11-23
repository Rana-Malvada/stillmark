-- Use a stable indexed cutoff for housekeeping only. Assertion validity still
-- uses the actual wall clock; the replay retention margin is unchanged.
CREATE OR REPLACE FUNCTION photo_security.gateway_identity_once(subject text, session_id uuid, assertion_id uuid, expiry bigint)
 RETURNS TABLE(name text, marker uuid, revoked boolean, epoch bigint)
 LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
 WITH cleanup AS (
  DELETE FROM photo_security.gateway_assertions WHERE jti IN (
   SELECT jti FROM photo_security.gateway_assertions WHERE expires_at < statement_timestamp()
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
