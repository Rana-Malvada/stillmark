-- Preserve exact-key caching, signed envelopes and the 60-second expiry limit.
SET LOCAL lock_timeout='5s';
CREATE OR REPLACE FUNCTION photo_security.write_role_cache(k text, body text, expires_ms bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE expiry timestamptz := to_timestamp(expires_ms / 1000.0);
BEGIN
  IF expiry <= clock_timestamp() OR expiry > clock_timestamp() + interval '60 seconds' THEN RETURN; END IF;
  -- Concurrent cache fills must not wait on the same expired entries.
  -- Lock candidates before deletion and skip entries another writer owns.
  DELETE FROM photo_security.role_cache WHERE cache_key IN (
    SELECT cache_key FROM photo_security.role_cache WHERE expires_at <= clock_timestamp()
    ORDER BY expires_at LIMIT 32 FOR UPDATE SKIP LOCKED
  );
  INSERT INTO photo_security.role_cache VALUES(k,body,expiry)
  ON CONFLICT(cache_key) DO UPDATE SET envelope=excluded.envelope, expires_at=excluded.expires_at;
END $$;
