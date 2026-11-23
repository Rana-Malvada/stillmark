-- Optional signed authorization cache shared across app replicas.
-- App verifies the HMAC and exact token/context/epoch key before using an entry.
-- Disabled unless NATIVE_ROLE_CACHE_SIGNING_KEY is configured on all replicas.
SET LOCAL lock_timeout='5s';
CREATE TABLE IF NOT EXISTS photo_security.role_cache (
  cache_key text PRIMARY KEY CHECK (cache_key ~ '^[a-f0-9]{64}$'),
  envelope text NOT NULL CHECK (octet_length(envelope) <= 2048),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS role_cache_expiry_idx ON photo_security.role_cache(expires_at);
REVOKE ALL ON photo_security.role_cache FROM PUBLIC, personal_photos_app;
CREATE OR REPLACE FUNCTION photo_security.read_role_cache(k text) RETURNS text
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT envelope FROM photo_security.role_cache WHERE cache_key=k AND expires_at > clock_timestamp()
$$;
CREATE OR REPLACE FUNCTION photo_security.write_role_cache(k text, body text, expires_ms bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE expiry timestamptz := to_timestamp(expires_ms / 1000.0);
BEGIN
  IF expiry <= clock_timestamp() OR expiry > clock_timestamp() + interval '60 seconds' THEN RETURN; END IF;
  -- Bounded expiry cleanup: no idle polling or background Snowflake queries.
  DELETE FROM photo_security.role_cache WHERE cache_key IN (
    SELECT cache_key FROM photo_security.role_cache WHERE expires_at <= clock_timestamp()
    ORDER BY expires_at LIMIT 32
  );
  INSERT INTO photo_security.role_cache VALUES(k,body,expiry)
  ON CONFLICT(cache_key) DO UPDATE SET envelope=excluded.envelope, expires_at=excluded.expires_at;
END $$;
REVOKE ALL ON FUNCTION photo_security.read_role_cache(text), photo_security.write_role_cache(text,text,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION photo_security.read_role_cache(text), photo_security.write_role_cache(text,text,bigint) TO personal_photos_app;
