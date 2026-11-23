BEGIN;
-- Block event writes briefly so backfill and the new insert trigger cannot miss/double-count rows.
LOCK TABLE user_activity_events IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE IF NOT EXISTS identity_log_sync (
 provider text PRIMARY KEY CHECK(provider IN ('auth0','snowflake')),
 cursor text, attempted_at timestamptz, completed_at timestamptz,
 imported integer NOT NULL DEFAULT 0, scanned integer NOT NULL DEFAULT 0,
 error text, more boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS user_activity_daily (
 day date NOT NULL, username text NOT NULL, kind text NOT NULL, provider text NOT NULL,
 events bigint NOT NULL DEFAULT 0, seconds numeric NOT NULL DEFAULT 0,
 bytes numeric NOT NULL DEFAULT 0, files numeric NOT NULL DEFAULT 0,
 successes bigint NOT NULL DEFAULT 0, failures bigint NOT NULL DEFAULT 0, skipped bigint NOT NULL DEFAULT 0,
 duration_ms numeric NOT NULL DEFAULT 0, results numeric NOT NULL DEFAULT 0,
 PRIMARY KEY(day,username,kind,provider)
);
INSERT INTO user_activity_daily
 SELECT (occurred_at AT TIME ZONE 'UTC')::date,username,kind,COALESCE(details->>'provider',source),count(*),
 COALESCE(sum((details->>'seconds')::numeric),0),COALESCE(sum((details->>'bytes')::numeric),0),COALESCE(sum((details->>'files')::numeric),0),
 count(*) FILTER(WHERE details->>'outcome'='success'),count(*) FILTER(WHERE details->>'outcome'='failed'),count(*) FILTER(WHERE details->>'outcome'='skipped'),
 COALESCE(sum((details->>'durationMs')::numeric),0),COALESCE(sum((details->>'results')::numeric),0)
 FROM user_activity_events WHERE occurred_at >= (now() AT TIME ZONE 'UTC')::date-interval '12 months'
 GROUP BY 1,2,3,4 ON CONFLICT DO NOTHING;
CREATE OR REPLACE FUNCTION summarize_user_activity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.occurred_at < (now() AT TIME ZONE 'UTC')::date-interval '12 months' THEN RETURN NEW; END IF;
 INSERT INTO user_activity_daily AS d VALUES(
 (NEW.occurred_at AT TIME ZONE 'UTC')::date,NEW.username,NEW.kind,COALESCE(NEW.details->>'provider',NEW.source),1,
 COALESCE((NEW.details->>'seconds')::numeric,0),COALESCE((NEW.details->>'bytes')::numeric,0),COALESCE((NEW.details->>'files')::numeric,0),
 CASE WHEN NEW.details->>'outcome'='success' THEN 1 ELSE 0 END,CASE WHEN NEW.details->>'outcome'='failed' THEN 1 ELSE 0 END,CASE WHEN NEW.details->>'outcome'='skipped' THEN 1 ELSE 0 END,
 COALESCE((NEW.details->>'durationMs')::numeric,0),COALESCE((NEW.details->>'results')::numeric,0))
 ON CONFLICT(day,username,kind,provider) DO UPDATE SET events=d.events+1,seconds=d.seconds+EXCLUDED.seconds,bytes=d.bytes+EXCLUDED.bytes,files=d.files+EXCLUDED.files,
 successes=d.successes+EXCLUDED.successes,failures=d.failures+EXCLUDED.failures,skipped=d.skipped+EXCLUDED.skipped,duration_ms=d.duration_ms+EXCLUDED.duration_ms,results=d.results+EXCLUDED.results;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS user_activity_summary_insert ON user_activity_events;
CREATE TRIGGER user_activity_summary_insert AFTER INSERT ON user_activity_events FOR EACH ROW EXECUTE FUNCTION summarize_user_activity();
COMMIT;
