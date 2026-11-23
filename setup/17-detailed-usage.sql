-- Postgres only; additive and safe to rerun.
ALTER TABLE user_activity_events ADD COLUMN IF NOT EXISTS details jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX IF NOT EXISTS user_activity_events_timeline ON user_activity_events(username,occurred_at DESC,event_id DESC);
